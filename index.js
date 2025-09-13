/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";

// Imports de Google Cloud
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI, HarmCategory, HarmBlockThreshold } from "@google-cloud/vertexai";

dotenv.config();
const app = express();
app.use(cors());
expressWs(app);

/*────────────────────── VARIABLES DE ENTORNO ───────────────────────*/
// Clave de Firebase (como la tenías antes)
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
// Clave de Google Cloud (la nueva)
const GOOGLE_APPLICATION_CREDENTIALS_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const GOOGLE_LOCATION = process.env.GOOGLE_LOCATION || "us-central1"; // O la región que prefieras

// Webhooks de n8n (como los tenías antes)
const N8N_REPORT_WEBHOOK_URL = process.env.N8N_REPORT_WEBHOOK_URL;
const N8N_SUPERVISOR_WEBHOOK_URL = process.env.N8N_SUPERVISOR_WEBHOOK_URL;

if (!SERVICE_ACCOUNT_JSON || !GOOGLE_APPLICATION_CREDENTIALS_JSON || !GOOGLE_PROJECT_ID) {
  console.error("CRITICAL: Faltan credenciales de Firebase o Google Cloud en las variables de entorno.");
  process.exit(1);
}


// Función de ayuda para corregir el formato de la clave privada
function fixPrivateKeyFormat(jsonString) {
  if (!jsonString) return null;
  const keyObject = JSON.parse(jsonString);
  if (keyObject.private_key) {
    keyObject.private_key = keyObject.private_key.replace(/\\n/g, '\n');
  }
  return keyObject;
}

// Firebase Admin (¡MODIFICADO!)
const firebaseServiceAccount = fixPrivateKeyFormat(SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(firebaseServiceAccount) });
const adminDb = admin.firestore();

// Google Cloud Clients (¡MODIFICADO!)
const googleCredentials = fixPrivateKeyFormat(GOOGLE_APPLICATION_CREDENTIALS_JSON);
const speechClient = new SpeechClient({ credentials: googleCredentials });
const vertexAI = new VertexAI({
    project: GOOGLE_PROJECT_ID,
    location: GOOGLE_LOCATION,
    credentials: googleCredentials
});

// Modelo Gemini Flash
const geminiModel = vertexAI.getGenerativeModel({
    model: 'gemini-1.5-flash-001',
    // Configuración de seguridad (opcional, pero recomendada)
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ],
});

console.log("Servicios de Firebase y Google Cloud inicializados correctamente.");

/*────────────────── SERVIDOR WEBSOCKET (/realtime-ws) ──────────────────*/
app.ws("/realtime-ws", (clientWs, req) => {
    console.log("[CLIENT CONNECTED]");

    let recognizeStream = null;
    let geminiChat = null;
    let conversationId = null;
    let fullConversationTranscript = "";
    let currentBotId = null; // Guardamos el ID del bot para las herramientas

    // Helper para enviar mensajes de forma segura al cliente
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

        const request = {
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 24000, // Tu frontend envía a 24kHz
                languageCode: languageCode,
                model: 'telephony', // Optimizado para voz
                enableAutomaticPunctuation: true,
            },
            interimResults: true, // Recibimos resultados parciales para baja latencia
        };

        recognizeStream = speechClient.streamingRecognize(request)
            .on('error', (err) => {
                console.error('[GOOGLE STT ERROR]', err);
                safeSend({ type: 'error', message: 'Error en la transcripción.' });
            })
            .on('data', onSpeechData);

        console.log(`[GOOGLE STT] Stream de transcripción iniciado en ${languageCode}.`);
    };

    const onSpeechData = async (data) => {
        const transcript = data.results[0]?.alternatives[0]?.transcript || "";
        const isFinal = data.results[0]?.isFinal || false;

        if (transcript) {
            safeSend({ type: 'transcript', text: transcript, isFinal });
        }

        if (isFinal && transcript.trim()) {
            console.log(`[TRANSCRIPT FINAL] Usuario: "${transcript.trim()}"`);
            fullConversationTranscript += `\nUSUARIO: ${transcript.trim()}`;
            // Una vez tenemos la transcripción final, llamamos a Gemini
            await getGeminiResponse(transcript.trim());
        }
    };

    const getGeminiResponse = async (userText) => {
        if (!geminiChat) {
            console.error("[GEMINI ERROR] El chat no ha sido inicializado. Falta `start_conversation`.");
            return;
        }
        
        try {
            const result = await geminiChat.sendMessageStream(userText);
            
            let fullResponseText = "";
            let functionCalls = [];

            for await (const item of result.stream) {
                if (item.candidates?.[0].content?.parts) {
                    item.candidates[0].content.parts.forEach(part => {
                        if (part.text) {
                            // No enviamos deltas, solo la respuesta final para simplificar.
                            // Tu sistema de TTS en paralelo funciona mejor con frases completas.
                            fullResponseText += part.text;
                        } else if (part.functionCall) {
                            // Gemini sugiere una herramienta.
                            console.log('[GEMINI TOOL CALL]', part.functionCall);
                            functionCalls.push(part.functionCall);
                        }
                    });
                }
            }
            
            if (functionCalls.length > 0) {
                // Lógica de herramientas (n8n)
                safeSend({ type: "tool_execution_start", toolName: functionCalls[0].name });
                // Aquí iría tu lógica para llamar a n8n, similar a la que tenías
                // Por ahora, simulamos un resultado exitoso.
                const toolResult = { status: "success", message: "Orden ejecutada en n8n." };
                safeSend({ type: "tool_execution_end", toolName: functionCalls[0].name, success: true });
                
                // Enviamos el resultado de vuelta a Gemini para que genere una respuesta final.
                await getGeminiResponse(JSON.stringify({
                    tool_response: {
                        name: functionCalls[0].name,
                        content: toolResult
                    }
                }));

            } else if (fullResponseText.trim()) {
                console.log(`[GEMINI RESPONSE] Asistente: "${fullResponseText.trim()}"`);
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
            // Es un chunk de audio
            if (recognizeStream) {
                recognizeStream.write(messageData);
            }
        } else {
            // Es un mensaje JSON
            const msg = JSON.parse(messageData.toString());

            switch (msg.type) {
                case 'start_conversation':
                    try {
                        // Verificamos AppCheck como antes
                        await admin.appCheck().verifyToken(msg.appCheckToken);
                        currentBotId = msg.botId;

                        const botSnap = await adminDb.collection("InteracBotGPT").doc(currentBotId).get();
                        if (!botSnap.exists) throw new Error(`Bot ${currentBotId} no encontrado.`);
                        const botData = botSnap.data();

                        const language = botData.language?.toLowerCase() === 'en' ? 'en-US' : 'es-ES';
                        startGoogleSpeechStream(language);

                        // Preparamos el system prompt y las herramientas para Gemini
                        const systemPrompt = `Simula que eres ${botData.Variable1 || 'un asistente virtual'}... ${botData.Variable2 || ''}`;
                        const tools = botData.openaiToolsJson ? JSON.parse(botData.openaiToolsJson).map(t => ({ functionDeclarations: [t] })) : [];

                        geminiChat = geminiModel.startChat({
                            history: [{ role: "user", parts: [{ text: "Hola" }] }, { role: "model", parts: [{ text: "Hola, ¿en qué puedo ayudarte?" }] }],
                            systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
                            tools: tools
                        });

                        // Creamos la conversación en Firebase como antes
                        const convRef = await adminDb.collection("Conversations").add({
                             RobotId: currentBotId, StartTime: admin.firestore.Timestamp.now(), /* ...otros campos... */
                        });
                        conversationId = convRef.id;
                        console.log(`[DB] Conversación creada: ${conversationId}`);

                        safeSend({ type: 'info', message: 'Backend conectado y listo.' });

                    } catch (e) {
                        console.error("[START_CONV ERROR]", e.message);
                        safeSend({ type: 'error', message: e.message });
                    }
                    break;
                
                case 'stop':
                    // El usuario soltó el botón del micrófono
                    // Google STT detectará el final del habla por sí mismo.
                    // No necesitamos hacer nada especial aquí, solo esperar el `isFinal: true`.
                    console.log("[CLIENT] Recibido 'stop'. Esperando transcripción final de Google.");
                    break;
                
                case 'conversation.item.create':
                    // Mensaje de texto del usuario
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
        console.log('[CLIENT DISCONNECTED]');
        if (recognizeStream) {
            recognizeStream.end();
        }
        // Aquí iría tu lógica para el webhook de informe de n8n
    });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));