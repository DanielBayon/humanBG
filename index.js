/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI } from "@google-cloud/vertexai";
import fs from 'fs'; // Módulo de Node.js para manejar archivos
import path from 'path'; // Módulo para manejar rutas de archivos
import os from 'os'; // Módulo para encontrar el directorio temporal del sistema

// --- CONFIGURACIÓN DE CREDENCIALES (MÉTODO DOCUMENTADO Y ROBUSTO) ---
// Esto se ejecuta ANTES que cualquier otra cosa.
try {
    console.log("Configurando credenciales de Google Cloud de forma programática...");
    const jsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!jsonString) {
        throw new Error("La variable de entorno GOOGLE_APPLICATION_CREDENTIALS_JSON no está definida.");
    }
    
    // Crear una ruta de archivo segura en el directorio temporal del sistema
    const credentialsPath = path.join(os.tmpdir(), 'gcloud-credentials.json');

    // Escribir el contenido del JSON en el archivo
    fs.writeFileSync(credentialsPath, jsonString.replace(/\\n/g, '\n'));

    // Establecer la variable de entorno que esperan los SDK de Google
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    console.log(`✔️ Credenciales escritas en ${credentialsPath} y variable de entorno establecida.`);

} catch (error) {
    console.error("CRITICAL: Fallo fatal al configurar las credenciales.", error);
    process.exit(1);
}
// --- FIN DE LA CONFIGURACIÓN DE CREDENCIALES ---


dotenv.config();
const app = express();
app.use(cors({ origin: '*' }));
expressWs(app);

/*────────────────────── INICIALIZACIÓN DE SERVICIOS ───────────────────────*/
// Ahora que el entorno está preparado, los SDK se inicializan sin argumentos.
let adminDb, speechClient, vertexAI, geminiModel, appCheck;

try {
    console.log("Inicializando servicios con credenciales por defecto del entorno...");

    const firebaseApp = admin.initializeApp();
    adminDb = firebaseApp.firestore();
    appCheck = firebaseApp.appCheck();
    console.log("✔️ Firebase Admin SDK y AppCheck inicializados.");

    speechClient = new SpeechClient();
    console.log("✔️ SpeechClient inicializado.");

    vertexAI = new VertexAI({ project: process.env.GOOGLE_PROJECT_ID, location: process.env.GOOGLE_LOCATION || "us-central1" });
    geminiModel = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    console.log("✔️ VertexAI (Gemini) inicializado.");

    console.log("✅ Todos los servicios se inicializaron correctamente.");

} catch (error) {
    console.error("CRITICAL: Fallo durante la inicialización de servicios.", error);
    process.exit(1);
}

/*────────────────── SERVIDOR WEBSOCKET (/realtime-ws) ──────────────────*/
app.ws("/realtime-ws", (clientWs, req) => {
    console.log("[CLIENT CONNECTED]");
    let recognizeStream = null, geminiChat = null;

    const safeSend = (data) => {
        if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data));
    };

    const startGoogleSpeechStream = (languageCode = 'es-ES') => {
        if (recognizeStream) recognizeStream.end();
        recognizeStream = speechClient.streamingRecognize({
            config: { encoding: 'LINEAR16', sampleRateHertz: 24000, languageCode, model: 'telephony', enableAutomaticPunctuation: true },
            interimResults: true,
        }).on('error', console.error).on('data', onSpeechData);
        console.log(`[STT] Stream iniciado en ${languageCode}.`);
    };

    const onSpeechData = async (data) => {
        const transcript = data.results[0]?.alternatives[0]?.transcript || "";
        const isFinal = data.results[0]?.isFinal || false;
        if (transcript) safeSend({ type: 'transcript', text: transcript, isFinal });
        if (isFinal && transcript.trim()) {
            await getGeminiResponse(transcript.trim());
        }
    };

    const getGeminiResponse = async (userText) => {
        if (!geminiChat) return;
        try {
            const result = await geminiChat.sendMessageStream(userText || " ");
            let fullResponseText = "";
            for await (const item of result.stream) {
                fullResponseText += item.candidates?.[0].content?.parts.map(p => p.text).join("") || "";
            }
            if (fullResponseText.trim()) {
                safeSend({ type: 'assistant_final', text: fullResponseText.trim() });
            }
        } catch (error) {
            console.error('[GEMINI API ERROR]', error.message);
            safeSend({ type: 'error', message: `Error en la API de Gemini: ${error.message}` });
        }
    };

    clientWs.on('message', async (messageData) => {
        if (Buffer.isBuffer(messageData)) {
            if (recognizeStream) recognizeStream.write(messageData);
        } else {
            const msg = JSON.parse(messageData.toString());
            switch (msg.type) {
                case 'start_conversation':
                    try {
                        await appCheck.verifyToken(msg.appCheckToken);
                        const botSnap = await adminDb.collection("InteracBotGPT").doc(msg.botId).get();
                        if (!botSnap.exists()) throw new Error("Bot no encontrado");
                        const botData = botSnap.data();
                        
                        startGoogleSpeechStream(botData.language?.toLowerCase() === 'en' ? 'en-US' : 'es-ES');
                        const systemPrompt = `Simula que eres ${botData.Variable1 || 'un asistente virtual'} y responde como crees que lo haría… ${botData.Variable5 ? `En la primera interacción, tu primera frase debe ser exactamente: "${botData.Variable5}".` : ''} ${botData.Variable2 || ''}`;
                        geminiChat = geminiModel.startChat({ systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } });
                        
                        safeSend({ type: 'info', message: 'Backend conectado y listo.' });
                        await getGeminiResponse("");
                    } catch (e) {
                        console.error("[START_CONV ERROR]", e);
                        safeSend({ type: 'error', message: e.message });
                    }
                    break;
                case 'conversation.item.create':
                    if (msg.item?.content?.[0]?.type === "input_text") {
                        await getGeminiResponse(msg.item.content[0].text);
                    }
                    break;
            }
        }
    });

    clientWs.on('close', () => {
        if (recognizeStream) recognizeStream.end();
        console.log('[CLIENT DISCONNECTED]');
    });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));