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

/*───────────────────────── CREDENCIALES GCP ─────────────────────────*/
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

/*───────────────────────── APP ─────────────────────────*/
const app = express();
app.use(cors({ origin: "*" }));
expressWs(app);

/*────────────────────── INICIALIZACIÓN DE SERVICIOS ───────────────────────*/
let adminDb, speechClient, vertexAI, geminiModel, appCheck;

try {
  console.log("Inicializando servicios con credenciales por defecto del entorno...");

  const firebaseApp = admin.initializeApp();
  adminDb = firebaseApp.firestore();
  appCheck = firebaseApp.appCheck?.(); // opcional según versión
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

/*────────────────── SERVIDOR WEBSOCKET (/realtime-ws) ──────────────────*/
app.ws("/realtime-ws", (clientWs, req) => {
  console.log("[CLIENT CONNECTED]");

  let recognizeStream = null;
  let geminiChat = null;

  // Estado de STT por conexión
  let currentLanguage = "es-ES";
  let lastPartial = "";
  let lastFinal = "";

  const safeSend = (data) => {
    try {
      if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data));
    } catch (_) {}
  };

  const stopGoogleSpeechStream = () => {
    if (recognizeStream) {
      try {
        recognizeStream.end();
      } catch (_) {}
      recognizeStream = null;
      lastPartial = "";
      console.log("[STT] Stream parado.");
    }
  };

  const startGoogleSpeechStream = (languageCode = currentLanguage) => {
    stopGoogleSpeechStream(); // aseguramos reinicio limpio
    currentLanguage = languageCode || currentLanguage;

    // Config V1 afinada a micro “normal”: 24 kHz + enhanced "video"
    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 24000,
        languageCode: currentLanguage,
        useEnhanced: true,
        model: "video",
        enableAutomaticPunctuation: true,
        enableSpokenPunctuation: { value: true },
        enableSpokenEmojis: { value: false },
        maxAlternatives: 1,
      },
      interimResults: true, // queremos interim para pintar en UI, no para historial
      // singleUtterance: false, // (doc antigua; no necesario aquí)
    };

    lastPartial = "";
    lastFinal = "";

    recognizeStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => {
        console.error("[STT ERROR]", err);
        safeSend({ type: "error", message: `STT error: ${err.message}` });
      })
      .on("data", onSpeechData)
      .on("end", () => {
        console.log("[STT] Stream ended.");
      });

    console.log(`[STT] Stream iniciado en ${currentLanguage}.`);
  };

  const onSpeechData = async (data) => {
    const result = data?.results?.[0];
    if (!result) return;

    const transcript = result.alternatives?.[0]?.transcript || "";
    const isFinal = !!result.isFinal;

    // Emitimos “interim” solo para UI (súper útil para pintar “va hablando…”)
    if (transcript && !isFinal) {
      if (transcript !== lastPartial) {
        lastPartial = transcript;
        safeSend({ type: "transcript", text: transcript, isFinal: false });
      }
      return;
    }

    // Si es final, añadimos al historial y disparamos Gemini solo 1 vez
    if (isFinal) {
      if (transcript && transcript !== lastFinal) {
        lastFinal = transcript;
        safeSend({ type: "transcript", text: transcript, isFinal: true });
        await getGeminiResponse(transcript.trim());
      }

      // Tras cada utterance final, rearmamos stream para la siguiente intervención
      // (opcional: si prefieres reutilizar, comenta la siguiente línea)
      stopGoogleSpeechStream();
      startGoogleSpeechStream(currentLanguage);
    }
  };

  const getGeminiResponse = async (userText) => {
    if (!geminiChat) return;
    try {
      const result = await geminiChat.sendMessageStream(userText || " ");
      let fullResponseText = "";
      for await (const item of result.stream) {
        const chunk =
          item?.candidates?.[0]?.content?.parts
            ?.map((p) => p?.text || "")
            .join("") || "";
        fullResponseText += chunk;
      }
      const finalText = fullResponseText.trim();
      if (finalText) safeSend({ type: "assistant_final", text: finalText });
    } catch (error) {
      console.error("[GEMINI API ERROR]", error);
      safeSend({ type: "error", message: `Error en la API de Gemini: ${error.message}` });
    }
  };

  clientWs.on("message", async (messageData) => {
    // 1) Audio binario → se lo pasamos al stream (auto-start si no existe)
    if (Buffer.isBuffer(messageData)) {
      try {
        if (!recognizeStream) startGoogleSpeechStream(currentLanguage);
        recognizeStream.write(messageData);
      } catch (e) {
        console.error("[AUDIO WRITE ERROR]", e);
      }
      return;
    }

    // 2) Mensajes JSON (o texto tipo "stop")
    let msg = null;
    let raw = null;

    try {
      raw = messageData.toString();
      msg = JSON.parse(raw);
    } catch {
      // Compatibilidad: si nos mandan el string "stop" (legado)
      if (raw && raw.trim().toLowerCase() === "stop") {
        msg = { type: "audio.stop" };
      } else {
        console.warn("[WS] Mensaje no JSON ignorado:", raw?.slice?.(0, 80));
        return;
      }
    }

    switch (msg.type) {
      case "start_conversation":
        try {
          // AppCheck opcional según tengas activado ese flujo
          if (appCheck && msg.appCheckToken) await appCheck.verifyToken(msg.appCheckToken);

          const botSnap = await adminDb.collection("InteracBotGPT").doc(msg.botId).get();
          if (!botSnap.exists) throw new Error("Bot no encontrado");
          const botData = botSnap.data();

          currentLanguage = botData.language?.toLowerCase() === "en" ? "en-US" : "es-ES";

          const systemPrompt = `Simula que eres ${botData.Variable1 || "un asistente virtual"} y responde como crees que lo haría… ${
            botData.Variable5 ? `En la primera interacción, tu primera frase debe ser exactamente: "${botData.Variable5}".` : ""
          } ${botData.Variable2 || ""}`;

          geminiChat = geminiModel.startChat({
            systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
          });

          startGoogleSpeechStream(currentLanguage);

          safeSend({ type: "info", message: "Backend conectado y listo." });
          await getGeminiResponse("");
        } catch (e) {
          console.error("[START_CONV ERROR]", e);
          safeSend({ type: "error", message: e.message });
        }
        break;

      case "conversation.item.create":
        // Texto escrito desde el front
        if (msg.item?.content?.[0]?.type === "input_text") {
          // Para texto escrito no necesitamos STT; respondemos directo
          await getGeminiResponse(msg.item.content[0].text);
        }
        break;

      case "audio.stop":
        // El usuario soltó el botón → cerramos utterance actual para forzar FINAL
        console.log("[WS] audio.stop recibido: cerrando stream STT para forzar final.");
        stopGoogleSpeechStream();
        // Reiniciamos listo para la siguiente
        startGoogleSpeechStream(currentLanguage);
        break;

      // Puedes añadir más mensajes si los necesitas (session_config, etc.)
    }
  });

  clientWs.on("close", () => {
    stopGoogleSpeechStream();
    console.log("[CLIENT DISCONNECTED]");
  });
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en puerto ${PORT}`));
