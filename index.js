/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI } from "@google-cloud/vertexai";

dotenv.config(); // No sobreescribe variables ya presentes en el entorno

const app = express();
app.use(cors());
expressWs(app);

/*────────────────────── FUNCIONES AUXILIARES ───────────────────────*/
function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function tryBase64ToUtf8(str) {
  try {
    const buf = Buffer.from(str, "base64");
    const txt = buf.toString("utf8");
    // Heurística mínima: debe empezar por { y contener "private_key"
    if (txt.trim().startsWith("{") && txt.includes("private_key")) return txt;
  } catch { /* ignore */ }
  return null;
}

function loadGoogleCredsFromEnv() {
  // Acepta cualquiera de las dos variables
  let raw = pickFirst(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  );

  if (!raw) {
    return { ok: false, reason: "ENV_MISSING", message: "No se encontró GOOGLE_APPLICATION_CREDENTIALS_JSON ni FIREBASE_SERVICE_ACCOUNT_KEY." };
  }

  let jsonString = raw.trim();

  // Si viene en Base64, decodificar
  if (!jsonString.startsWith("{")) {
    const decoded = tryBase64ToUtf8(jsonString);
    if (decoded) jsonString = decoded;
  }

  // Normalizar salto de línea de la clave privada si vino como texto con \\n
  jsonString = jsonString.replace(/\\n/g, "\n");

  try {
    const credentials = JSON.parse(jsonString);
    if (!credentials.client_email || !credentials.private_key) {
      return { ok: false, reason: "JSON_INCOMPLETE", message: "El JSON de credenciales no contiene client_email o private_key." };
    }
    const projectId = process.env.GOOGLE_PROJECT_ID?.trim() || credentials.project_id;
    if (!projectId) {
      return { ok: false, reason: "PROJECT_ID_MISSING", message: "Falta GOOGLE_PROJECT_ID y no hay project_id en el JSON." };
    }
    return { ok: true, credentials, projectId };
  } catch (e) {
    return { ok: false, reason: "JSON_PARSE", message: `No se pudo parsear el JSON de credenciales: ${e.message}` };
  }
}

/*────────────────────── DIAGNÓSTICO INICIAL ───────────────────────*/
console.log("--- INICIANDO DIAGNÓSTICO DE VARIABLES DE ENTORNO ---");
const hasGJson = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON.trim());
const hasFJson = !!(process.env.FIREBASE_SERVICE_ACCOUNT_KEY && process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim());
const hasProj  = !!(process.env.GOOGLE_PROJECT_ID && process.env.GOOGLE_PROJECT_ID.trim());

console.log(`GOOGLE_APPLICATION_CREDENTIALS_JSON: ${hasGJson ? "✔️ presente" : "❌ ausente"}`);
console.log(`FIREBASE_SERVICE_ACCOUNT_KEY:       ${hasFJson ? "✔️ presente" : "❌ ausente"}`);
console.log(`GOOGLE_PROJECT_ID:                  ${hasProj  ? "✔️ presente" : "❌ ausente"}`);

const loaded = loadGoogleCredsFromEnv();
if (!loaded.ok) {
  console.error("❌ CRITICAL:", loaded.message);
  console.error("Suele ser por variables en otro servicio/entorno, no redeploy, o no link de Shared Vars.");
  process.exit(1);
}

console.log(`✔️ Credenciales parseadas. project_id: ${loaded.projectId}`);
/*────────────────── INICIALIZACIÓN DE SERVICIOS ──────────────────*/
let speechClient, vertexAI, geminiModel, adminDb;

try {
  console.log("Inicializando Firebase Admin SDK...");
  admin.initializeApp({
    credential: admin.credential.cert(loaded.credentials),
    databaseURL: `https://${loaded.projectId}-default-rtdb.firebaseio.com`,
  });
  adminDb = admin.firestore();
  console.log("✔️ Firebase listo.");

  console.log("Inicializando Google Speech-to-Text Client...");
  speechClient = new SpeechClient({
    credentials: {
      client_email: loaded.credentials.client_email,
      private_key: loaded.credentials.private_key,
    },
    projectId: loaded.projectId,
  });
  console.log("✔️ Speech listo.");

  console.log("Inicializando Vertex AI (Gemini)...");
  vertexAI = new VertexAI({
    project: loaded.projectId,
    location: "us-central1",
    // Algunas versiones aceptan googleAuthOptions; otras, credentials:
    // Si tu versión da problemas, sustituye 'credentials' por:
    // googleAuthOptions: { credentials: { client_email: ..., private_key: ... } }
    credentials: {
      client_email: loaded.credentials.client_email,
      private_key: loaded.credentials.private_key,
    },
  });
  geminiModel = vertexAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });
  console.log("✔️ Vertex listo.");

  console.log("--- ✅ TODOS LOS SERVICIOS SE INICIALIZARON CORRECTAMENTE ---");
} catch (error) {
  console.error("❌ CRITICAL: Fallo al inicializar servicios.", error);
  process.exit(1);
}

/*────────────────── ENDPOINTS DE COMPROBACIÓN ──────────────────*/
app.get("/env-check", (_, res) => {
  res.json({
    has_GOOGLE_APPLICATION_CREDENTIALS_JSON: hasGJson,
    has_FIREBASE_SERVICE_ACCOUNT_KEY: hasFJson,
    has_GOOGLE_PROJECT_ID: hasProj,
    resolved_project_id: loaded.projectId,
  });
});

/*────────────────── SERVIDOR WEBSOCKET (TU LÓGICA) ──────────────────*/
app.ws("/realtime-ws", (clientWs, req) => {
  console.log("[CLIENT CONNECTED]");

  let recognizeStream = null;
  let geminiChat = null;
  let conversationId = null;
  let fullConversationTranscript = "";
  let currentBotId = null;

  const safeSend = (data) => {
    if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data));
  };

  const onSpeechData = async (data) => {
    const transcript = data.results[0]?.alternatives[0]?.transcript || "";
    const isFinal = data.results[0]?.isFinal || false;
    if (transcript) safeSend({ type: "transcript", text: transcript, isFinal });
    if (isFinal && transcript.trim()) {
      fullConversationTranscript += `\nUSUARIO: ${transcript.trim()}`;
      await getGeminiResponse(transcript.trim());
    }
  };

  const startGoogleSpeechStream = (languageCode = "es-ES") => {
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream.removeListener("data", onSpeechData);
    }
    recognizeStream = speechClient
      .streamingRecognize({
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 24000,
          languageCode,
          model: "telephony",
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
      })
      .on("error", console.error)
      .on("data", onSpeechData);
    console.log(`[GOOGLE STT] Stream iniciado en ${languageCode}.`);
  };

  const getGeminiResponse = async (userText) => {
    if (!geminiChat) return;
    try {
      const result = await geminiChat.sendMessageStream(userText);
      let fullResponseText = "";
      for await (const item of result.stream) {
        if (item.candidates?.[0].content?.parts) {
          item.candidates[0].content.parts.forEach((part) => {
            if (part.text) fullResponseText += part.text;
          });
        }
      }
      if (fullResponseText.trim()) {
        fullConversationTranscript += `\nASISTENTE: ${fullResponseText.trim()}`;
        safeSend({ type: "assistant_final", text: fullResponseText.trim() });
      }
    } catch (error) {
      console.error("[GEMINI API ERROR]", error);
      safeSend({ type: "error", message: "Error al generar la respuesta." });
    }
  };

  clientWs.on("message", async (messageData) => {
    if (Buffer.isBuffer(messageData)) {
      if (recognizeStream) recognizeStream.write(messageData);
    } else {
      const msg = JSON.parse(messageData.toString());
      switch (msg.type) {
        case "start_conversation":
          try {
            await admin.appCheck().verifyToken(msg.appCheckToken);
            currentBotId = msg.botId;

            const botSnap = await adminDb.collection("InteracBotGPT").doc(currentBotId).get();
            const botData = botSnap.data();

            startGoogleSpeechStream(botData?.language?.toLowerCase() === "en" ? "en-US" : "es-ES");

            const systemPrompt = `Simula que eres ${botData?.Variable1 || "un asistente virtual"}... ${botData?.Variable2 || ""}`;
            geminiChat = geminiModel.startChat({
              systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
            });

            const convRef = await adminDb.collection("Conversations").add({ RobotId: currentBotId });
            conversationId = convRef.id;
            safeSend({ type: "info", message: "Backend conectado y listo." });
          } catch (e) {
            safeSend({ type: "error", message: e.message });
          }
          break;

        case "conversation.item.create":
          if (msg.item?.content?.[0]?.type === "input_text") {
            const userText = msg.item.content[0].text;
            fullConversationTranscript += `\nUSUARIO (texto): ${userText}`;
            await getGeminiResponse(userText);
          }
          break;
      }
    }
  });

  clientWs.on("close", () => {
    if (recognizeStream) recognizeStream.end();
    console.log("[CLIENT DISCONNECTED]");
  });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));
