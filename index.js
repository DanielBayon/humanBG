/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI } from "@google-cloud/vertexai";

dotenv.config();
const app = express();
app.use(cors({ origin: '*' }));
expressWs(app);

/*────────────────────── INICIALIZACIÓN DE SERVICIOS (VERSIÓN DEFINITIVA Y CORRECTA) ───────────────────────*/
let adminDb, speechClient, vertexAI, geminiModel, appCheck;

try {
    console.log("Iniciando inicialización de servicios...");

    const {
        FIREBASE_SERVICE_ACCOUNT_KEY,
        GOOGLE_APPLICATION_CREDENTIALS_JSON,
        GOOGLE_PROJECT_ID,
        GOOGLE_LOCATION = "us-central1"
    } = process.env;

    if (!FIREBASE_SERVICE_ACCOUNT_KEY || !GOOGLE_APPLICATION_CREDENTIALS_JSON || !GOOGLE_PROJECT_ID) {
        throw new Error("Faltan una o más variables de entorno críticas.");
    }

    /**
     * Función definitiva para procesar credenciales JSON desde variables de entorno.
     * 1. Prepara el string para que sea un JSON sintácticamente válido (escapa newlines).
     * 2. Parsea el JSON.
     * 3. Restaura los newlines en la clave privada para que sea criptográficamente válida.
     * @param {string} jsonString - El contenido de la variable de entorno.
     * @param {string} serviceName - Nombre del servicio para logging de errores.
     * @returns {object} El objeto de credenciales listo para ser usado.
     */
    const fixAndParseCredentials = (jsonString, serviceName) => {
        try {
            // Paso 1: Reemplazar saltos de línea literales por su secuencia de escape "\\n"
            // para que la cadena completa sea un JSON válido.
            const validJsonString = jsonString.replace(/\n/g, "\\n");
            
            // Paso 2: Parsear el string que ahora es sintácticamente correcto.
            const credentialsObject = JSON.parse(validJsonString);
            
            // Paso 3: Dentro del objeto, restaurar los saltos de línea en el campo private_key
            // para que las librerías de autenticación puedan usar la clave PEM.
            if (credentialsObject.private_key) {
                credentialsObject.private_key = credentialsObject.private_key.replace(/\\n/g, '\n');
            }
            
            return credentialsObject;
        } catch (e) {
            console.error(`Error de sintaxis en el JSON para ${serviceName}. Verifica el contenido de la variable de entorno.`);
            throw new Error(`Error al procesar las credenciales para ${serviceName}: ${e.message}`);
        }
    };

    // 1. Inicializar Firebase con SUS credenciales
    console.log("Procesando credenciales de Firebase...");
    const firebaseCreds = fixAndParseCredentials(FIREBASE_SERVICE_ACCOUNT_KEY, "Firebase");
    const firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(firebaseCreds)
    });
    adminDb = firebaseApp.firestore();
    appCheck = firebaseApp.appCheck();
    console.log("✔️ Firebase Admin SDK y AppCheck inicializados.");

    // 2. Inicializar Google Cloud Services con SUS credenciales
    console.log("Procesando credenciales de Google Cloud...");
    const googleCreds = fixAndParseCredentials(GOOGLE_APPLICATION_CREDENTIALS_JSON, "Google Cloud");
    const clientOptions = { projectId: GOOGLE_PROJECT_ID, credentials: googleCreds };

    speechClient = new SpeechClient(clientOptions);
    console.log("✔️ SpeechClient inicializado.");

    vertexAI = new VertexAI({ project: GOOGLE_PROJECT_ID, location: GOOGLE_LOCATION, credentials: googleCreds });
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

    const safeSend = (data) => { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); };

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
        if (isFinal && transcript.trim()) await getGeminiResponse(transcript.trim());
    };

    const getGeminiResponse = async (userText) => {
        if (!geminiChat) return;
        try {
            const result = await geminiChat.sendMessageStream(userText || " ");
            let fullResponseText = "";
            for await (const item of result.stream) {
                fullResponseText += item.candidates?.[0].content?.parts.map(p => p.text).join("") || "";
            }
            if (fullResponseText.trim()) safeSend({ type: 'assistant_final', text: fullResponseText.trim() });
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

    clientWs.on('close', () => { if (recognizeStream) recognizeStream.end(); console.log('[CLIENT DISCONNECTED]'); });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));