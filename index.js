/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI } from "@google-cloud/vertexai";
import fs from "fs";
import path from "path";
import os from "os";

/*──────────────────── CREDENCIALES GOOGLE CLOUD ───────────────────*/
try {
  console.log("Configurando credenciales de Google Cloud de forma programática...");
  const jsonString = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!jsonString) throw new Error("La variable de entorno GOOGLE_CREDENTIALS_JSON no está definida.");
  const credentialsPath = path.join(os.tmpdir(), "gcloud-credentials.json");
  fs.writeFileSync(credentialsPath, jsonString);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  console.log(`✔️ Credenciales escritas en ${credentialsPath} y variable de entorno establecida.`);
} catch (error) {
  console.error("CRITICAL: Fallo fatal al configurar las credenciales.", error);
  process.exit(1);
}

dotenv.config();
const app = express();
app.use(cors({ origin: "*" }));
expressWs(app);

/*──────────────────── INICIALIZACIÓN DE SERVICIOS ───────────────────*/
let adminDb, speechClient, vertexAI, geminiModel, appCheck;

try {
  console.log("Inicializando servicios con credenciales por defecto del entorno...");

  const firebaseApp = admin.initializeApp();
  adminDb = firebaseApp.firestore();
  appCheck = firebaseApp.appCheck();
  console.log("✔️ Firebase Admin SDK y AppCheck inicializados.");

  speechClient = new SpeechClient();
  console.log("✔️ SpeechClient inicializado.");

  vertexAI = new VertexAI({
    project: process.env.GOOGLE_PROJECT_ID,
    location: process.env.GOOGLE_LOCATION || "us-central1",
  });
  geminiModel = vertexAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  console.log("✔️ VertexAI (Gemini) inicializado.");

  console.log("✅ Todos los servicios se inicializaron correctamente.");
} catch (error) {
  console.error("CRITICAL: Fallo durante la inicialización de servicios.", error);
  process.exit(1);
}

/*────────────────────────── HELPERS WS / STT ──────────────────────────*/
const WS_OPEN = 1;
const safeSend = (ws, data) => {
  try { if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(data)); } catch (_) {}
};
const normalizeLang = (lang) => {
  if (!lang) return "es-ES";
  const s = String(lang).toLowerCase();
  if (s.startsWith("en")) return "en-US";
  if (s.startsWith("es")) return "es-ES";
  return lang;
};

/*────────────────── WEBSOCKET /realtime-ws ──────────────────*/
app.ws("/realtime-ws", (clientWs) => {
  console.log("[CLIENT CONNECTED]");
  let recognizeStream = null;
  let sttLanguageCode = "es-ES";
  let geminiChat = null;
  let lastFinalNorm = "";

  const sttIsActive = () =>
    recognizeStream && !recognizeStream.writableEnded && !recognizeStream.destroyed;

  const endStt = (reason = "normal") => {
    if (recognizeStream) {
      try { recognizeStream.end(); } catch (_) {}
      recognizeStream = null;
    }
    console.log(`[STT] Stream finalizado (${reason}).`);
  };

  const startSttStream = (lang = "es-ES") => {
    sttLanguageCode = normalizeLang(lang);

    // ► Modelo recomendado para español y habla de longitud variable
    //    (interims en vivo + cierres controlados por el cliente).
    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 24000,
        languageCode: sttLanguageCode,
        model: "latest_long",                 // en lugar de 'video' / 'telephony'
        enableAutomaticPunctuation: true,
        maxAlternatives: 1,
      },
      interimResults: true,                   // interims para latencia mínima
      // singleUtterance se omite aquí: nosotros cerramos en audio.stop
    };

    endStt("restart"); // por si algún stream previo quedó abierto

    recognizeStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => {
        console.error("[STT error]", err?.message || err);
        safeSend(clientWs, { type: "error", message: `STT error: ${err.message || err}` });
        endStt("error");
      })
      .on("data", onSpeechData)
      .on("end", () => {
        console.log("[STT] 'end' recibido.");
        endStt("end_event");
      });

    console.log(`[STT] Stream iniciado con ${sttLanguageCode} (latest_long, 24kHz, interims).`);
  };

  async function onSpeechData(data) {
    try {
      const result = data.results?.[0];
      if (!result) return;

      const transcript = result.alternatives?.[0]?.transcript || "";
      const isFinal = !!result.isFinal;

      if (transcript) {
        safeSend(clientWs, { type: "transcript", text: transcript, isFinal });
      }

      if (isFinal) {
        const norm = transcript.trim().toLowerCase();
        // Anti-duplicado por ecos y finales repetidos
        if (norm && norm !== lastFinalNorm) {
          lastFinalNorm = norm;
          await getGeminiResponse(norm);
        }
      }
    } catch (e) {
      console.error("[onSpeechData ERROR]", e);
    }
  }

  async function getGeminiResponse(userText) {
    if (!geminiChat) return;
    try {
      const result = await geminiChat.sendMessageStream(userText || " ");
      let fullResponseText = "";
      for await (const item of result.stream) {
        fullResponseText += item.candidates?.[0].content?.parts.map((p) => p.text).join("") || "";
      }
      if (fullResponseText.trim()) {
        safeSend(clientWs, { type: "assistant_final", text: fullResponseText.trim() });
      }
    } catch (error) {
      console.error("[GEMINI API ERROR]", error);
      safeSend(clientWs, { type: "error", message: `Error en la API de Gemini: ${error.message}` });
    }
  }

  clientWs.on("message", async (messageData) => {
    try {
      if (Buffer.isBuffer(messageData)) {
        // Audio PCM16 mono 24 kHz del navegador
        if (sttIsActive()) {
          try { recognizeStream.write(messageData); }
          catch (e) { console.warn("[STT write] ignorado (stream inactivo):", e?.message); }
        }
        return;
      }

      // Mensaje textual
      let msg;
      try { msg = JSON.parse(messageData.toString()); }
      catch {
        // Compatibilidad: "stop" plano
        if (String(messageData).trim().toLowerCase() === "stop") { endStt("legacy_stop"); }
        else console.warn("[WS] Mensaje no-JSON ignorado:", String(messageData));
        return;
      }

      switch (msg.type) {
        case "start_conversation": {
          try {
            await appCheck.verifyToken(msg.appCheckToken);
            const botSnap = await adminDb.collection("InteracBotGPT").doc(msg.botId).get();
            if (!botSnap.exists) throw new Error("Bot no encontrado");
            const botData = botSnap.data();

            const langCode = (botData.language?.toLowerCase() === "en") ? "en-US" : "es-ES";
            const systemPrompt =
              `Simula que eres ${botData.Variable1 || "un asistente virtual"} y responde como crees que lo haría… ` +
              (botData.Variable5 ? `En la primera interacción, tu primera frase debe ser exactamente: "${botData.Variable5}". ` : "") +
              (botData.Variable2 || "");

            geminiChat = geminiModel.startChat({
              systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
            });

            safeSend(clientWs, { type: "info", message: "Backend conectado y listo." });
            await getGeminiResponse("");
          } catch (e) {
            console.error("[START_CONV ERROR]", e);
            safeSend(clientWs, { type: "error", message: e.message });
          }
          break;
        }

        case "audio.start": {
          const lang = normalizeLang(msg.languageCode || "es-ES");
          startSttStream(lang);
          break;
        }

        case "audio.stop": {
          endStt("client_stop");
          break;
        }

        case "conversation.item.create": {
          const text = msg.item?.content?.[0]?.type === "input_text" ? msg.item.content[0].text : "";
          if (text) await getGeminiResponse(text);
          break;
        }
      }
    } catch (e) {
      console.error("[WS onmessage ERROR]", e);
      safeSend(clientWs, { type: "error", message: e.message });
    }
  });

  clientWs.on("close", () => {
    endStt("client_close");
    console.log("[CLIENT DISCONNECTED]");
  });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));
