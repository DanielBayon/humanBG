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

/*────────────────────── VARIABLES DE ENTORNO ───────────────────────*/
const FIREBASE_JSON_STRING = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const GOOGLE_JSON_STRING = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const GOOGLE_LOCATION = process.env.GOOGLE_LOCATION || "us-central1";

if (!FIREBASE_JSON_STRING || !GOOGLE_JSON_STRING || !GOOGLE_PROJECT_ID) {
  console.error("CRITICAL: Faltan FIREBASE_SERVICE_ACCOUNT_KEY, GOOGLE_APPLICATION_CREDENTIALS_JSON, o GOOGLE_PROJECT_ID.");
  process.exit(1);
}

let adminDb, speechClient, vertexAI, geminiModel;

try {
    // Función de ayuda robusta para parsear y corregir credenciales
    const fixAndParseCredentials = (jsonString, serviceName) => {
        if (!jsonString || jsonString.length < 10) {
            throw new Error(`La cadena JSON para ${serviceName} está vacía o es inválida.`);
        }
        try {
            const correctedString = jsonString.replace(/\\n/g, '\n');
            return JSON.parse(correctedString);
        } catch (e) {
            throw new Error(`Error al parsear el JSON para ${serviceName}: ${e.message}`);
        }
    };

    // --- INICIALIZACIÓN EXPLÍCITA DE CADA SERVICIO ---

    // 1. Firebase Admin SDK
    console.log("Inicializando Firebase Admin SDK...");
    const firebaseCreds = fixAndParseCredentials(FIREBASE_JSON_STRING, "Firebase");
    admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
    adminDb = admin.firestore();
    console.log("✔️ Firebase Admin SDK inicializado.");

    // 2. Google Cloud SDKs (Speech y Vertex)
    console.log("Inicializando Google Cloud SDKs...");
    const googleCreds = fixAndParseCredentials(GOOGLE_JSON_STRING, "Google Cloud");
    
    // Se pasa explícitamente projectId Y credentials para anular cualquier búsqueda por defecto.
    const clientOptions = {
        projectId: GOOGLE_PROJECT_ID,
        credentials: googleCreds
    };

    speechClient = new SpeechClient(clientOptions);
    console.log("✔️ SpeechClient inicializado explícitamente.");

    vertexAI = new VertexAI({
        project: GOOGLE_PROJECT_ID,
        location: GOOGLE_LOCATION,
        credentials: googleCreds
    });
    console.log("✔️ VertexAI inicializado explícitamente.");

    geminiModel = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    console.log("✔️ Modelo Gemini cargado.");

    console.log("✅ Todos los servicios se inicializaron correctamente.");

} catch (error) {
    console.error("CRITICAL: Fallo durante la inicialización de servicios.", error);
    process.exit(1);
}

/*────────────────── SERVIDOR WEBSOCKET (/realtime-ws) ──────────────────*/
// El código del WebSocket de aquí en adelante no necesita cambios.
// Pega el que ya tenías. Te lo incluyo completo por seguridad.
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
        }).on('error', (err) => {
            console.error('[GOOGLE STT ERROR]', err);
            safeSend({ type: 'error', message: 'Error en la transcripción.' });
        }).on('data', onSpeechData);
        console.log(`[GOOGLE STT] Stream iniciado en ${languageCode}.`);
    };

    const onSpeechData = async (data) => {
        const transcript = data.results[0]?.alternatives[0]?.transcript || "";
        const isFinal = data.results[0]?.isFinal || false;
        if (transcript) safeSend({ type: 'transcript', text: transcript, isFinal });
        if (isFinal && transcript.trim()) {
            console.log(`[TRANSCRIPT FINAL] Usuario: "${transcript.trim()}"`);
            fullConversationTranscript += `\nUSUARIO: ${transcript.trim()}`;
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
                console.log(`[GEMINI RESPONSE] Asistente: "${fullResponseText.trim()}"`);
                fullConversationTranscript += `\nASISTENTE: ${fullResponseText.trim()}`;
                safeSend({ type: 'assistant_final', text: fullResponseText.trim() });
            }
        } catch (error) {
            console.error('[GEMINI API ERROR]', error.message);
            // El error que veías en el frontend venía de aquí.
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
                        await admin.appCheck().verifyToken(msg.appCheckToken);
                        currentBotId = msg.botId;
                        const botSnap = await adminDb.collection("InteracBotGPT").doc(currentBotId).get();
                        if (!botSnap.exists()) throw new Error("Bot no encontrado");
                        const botData = botSnap.data();
                        
                        startGoogleSpeechStream(botData.language?.toLowerCase() === 'en' ? 'en-US' : 'es-ES');
                        const systemPrompt = `Simula que eres ${botData.Variable1 || 'un asistente virtual'} y responde como crees que lo haría… ${botData.Variable5 ? `En la primera interacción, tu primera frase debe ser exactamente: "${botData.Variable5}".` : ''} ${botData.Variable2 || ''}`;
                        geminiChat = geminiModel.startChat({ systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } });

                        await adminDb.collection("Conversations").add({ RobotId: currentBotId, StartTime: admin.firestore.Timestamp.now() });
                        safeSend({ type: 'info', message: 'Backend conectado y listo.' });
                        await getGeminiResponse("");
                    } catch (e) {
                        console.error("[START_CONV ERROR]", e.message);
                        safeSend({ type: 'error', message: e.message });
                    }
                    break;
                case 'conversation.item.create':
                    if (msg.item?.content?.[0]?.type === "input_text") {
                        const userText = msg.item.content[0].text;
                        console.log(`[TEXTO] Usuario: "${userText}"`);
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