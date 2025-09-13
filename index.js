/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI, HarmCategory, HarmBlockThreshold } from "@google-cloud/vertexai";

dotenv.config();
const app = express();
app.use(cors());
expressWs(app);

/*────────────────────── DEPURACIÓN DE VARIABLES DE ENTORNO ───────────────────────*/
console.log("--- INICIANDO DIAGNÓSTICO DE VARIABLES DE ENTORNO ---");

const GOOGLE_CREDS_JSON_STRING = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;

let hasError = false;

// 1. Verificar existencia de las variables
if (GOOGLE_CREDS_JSON_STRING) {
    console.log(`✔️ GOOGLE_APPLICATION_CREDENTIALS_JSON: Encontrada (longitud: ${GOOGLE_CREDS_JSON_STRING.length} caracteres).`);
} else {
    console.error("❌ CRITICAL: La variable GOOGLE_APPLICATION_CREDENTIALS_JSON no existe o está vacía.");
    hasError = true;
}

if (GOOGLE_PROJECT_ID) {
    console.log(`✔️ GOOGLE_PROJECT_ID: Encontrado (valor: ${GOOGLE_PROJECT_ID}).`);
} else {
    console.error("❌ CRITICAL: La variable GOOGLE_PROJECT_ID no existe o está vacía.");
    hasError = true;
}

if (hasError) {
    console.error("--- DIAGNÓSTICO FALLIDO: Faltan variables. El proceso terminará. ---");
    process.exit(1);
}

/*────────────────── INICIALIZACIÓN DE SERVICIOS ──────────────────*/
let speechClient, vertexAI, geminiModel, adminDb;

try {
    console.log("--- Intentando inicializar servicios con las credenciales proporcionadas... ---");

    // 2. Corregir y parsear el JSON
    console.log("Paso 1: Corrigiendo formato de la clave privada...");
    const correctedJsonString = GOOGLE_CREDS_JSON_STRING.replace(/\\n/g, '\n');
    
    console.log("Paso 2: Parseando la cadena JSON corregida...");
    const credentials = JSON.parse(correctedJsonString);
    console.log(`✔️ JSON parseado correctamente. Project ID del JSON: ${credentials.project_id}`);

    // 3. Inicializar todos los servicios con las mismas credenciales
    console.log("Paso 3: Inicializando Firebase Admin SDK...");
    admin.initializeApp({
        credential: admin.credential.cert(credentials),
        databaseURL: `https://${credentials.project_id}-default-rtdb.firebaseio.com` // Opcional pero buena práctica
    });
    adminDb = admin.firestore();
    console.log("✔️ Firebase Admin SDK inicializado.");

    console.log("Paso 4: Inicializando Google Speech-to-Text Client...");
    speechClient = new SpeechClient({ credentials });
    console.log("✔️ Google Speech-to-Text Client inicializado.");
    
    console.log("Paso 5: Inicializando Vertex AI (Gemini)...");
    vertexAI = new VertexAI({ project: GOOGLE_PROJECT_ID, location: "us-central1", credentials });
    geminiModel = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    console.log("✔️ Vertex AI (Gemini) inicializado.");
    
    console.log("--- ✅ TODOS LOS SERVICIOS SE INICIALIZARON CORRECTAMENTE ---");

} catch (error) {
    console.error("❌ CRITICAL: Fallo durante la inicialización de servicios.");
    if (error instanceof SyntaxError) {
        console.error("El error es de tipo SyntaxError. Esto indica que el JSON de la variable de entorno está malformado.");
    }
    console.error("Detalles del error:", error);
    console.log("--- DIAGNÓSTICO FALLIDO: Error en la inicialización. El proceso terminará. ---");
    process.exit(1);
}

/*────────────────── SERVIDOR WEBSOCKET (SIN CAMBIOS) ──────────────────*/
// Pega aquí el código completo de app.ws de la respuesta anterior.
// No necesita ninguna modificación.
app.ws("/realtime-ws", (clientWs, req) => {
    console.log("[CLIENT CONNECTED]");

    let recognizeStream = null;
    let geminiChat = null;
    let conversationId = null;
    let fullConversationTranscript = "";
    let currentBotId = null;

    const safeSend = (data) => {
        if (clientWs.readyState === 1) { // WebSocket.OPEN
            clientWs.send(JSON.stringify(data));
        }
    };

    const startGoogleSpeechStream = (languageCode = 'es-ES') => {
        if (recognizeStream) {
            recognizeStream.end();
            recognizeStream.removeListener('data', onSpeechData);
        }
        recognizeStream = speechClient.streamingRecognize({
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 24000,
                languageCode: languageCode,
                model: 'telephony',
                enableAutomaticPunctuation: true,
            },
            interimResults: true,
        }).on('error', console.error).on('data', onSpeechData);
        console.log(`[GOOGLE STT] Stream iniciado en ${languageCode}.`);
    };

    const onSpeechData = async (data) => {
        const transcript = data.results[0]?.alternatives[0]?.transcript || "";
        const isFinal = data.results[0]?.isFinal || false;
        if (transcript) safeSend({ type: 'transcript', text: transcript, isFinal });
        if (isFinal && transcript.trim()) {
            fullConversationTranscript += `\nUSUARIO: ${transcript.trim()}`;
            await getGeminiResponse(transcript.trim());
        }
    };

    const getGeminiResponse = async (userText) => {
        if (!geminiChat) return;
        try {
            const result = await geminiChat.sendMessageStream(userText);
            
            let fullResponseText = "";
            for await (const item of result.stream) {
                if (item.candidates?.[0].content?.parts) {
                    item.candidates[0].content.parts.forEach(part => {
                        if (part.text) fullResponseText += part.text;
                    });
                }
            }
            
            if (fullResponseText.trim()) {
                fullConversationTranscript += `\nASISTENTE: ${fullResponseText.trim()}`;
                safeSend({ type: 'assistant_final', text: fullResponseText.trim() });
            }
        } catch (error) {
            console.error('[GEMINI API ERROR]', error);
            safeSend({ type: 'error', message: 'Error al generar la respuesta.' });
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
                        await admin.appCheck().verifyToken(msg.appCheckToken);
                        currentBotId = msg.botId;

                        const botSnap = await adminDb.collection("InteracBotGPT").doc(currentBotId).get();
                        const botData = botSnap.data();
                        
                        startGoogleSpeechStream(botData.language?.toLowerCase() === 'en' ? 'en-US' : 'es-ES');

                        const systemPrompt = `Simula que eres ${botData.Variable1 || 'un asistente virtual'}... ${botData.Variable2 || ''}`;
                        geminiChat = geminiModel.startChat({ systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } });

                        const convRef = await adminDb.collection("Conversations").add({ RobotId: currentBotId, /* ... */ });
                        conversationId = convRef.id;
                        safeSend({ type: 'info', message: 'Backend conectado y listo.' });
                    } catch (e) {
                        safeSend({ type: 'error', message: e.message });
                    }
                    break;
                case 'conversation.item.create':
                    if (msg.item?.content?.[0]?.type === "input_text") {
                        const userText = msg.item.content[0].text;
                        fullConversationTranscript += `\nUSUARIO (texto): ${userText}`;
                        await getGeminiResponse(userText);
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