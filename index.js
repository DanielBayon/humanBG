/*───────────────────────── IMPORTS Y CONFIGURACIÓN ─────────────────────────*/
import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import cors from "cors";
import admin from "firebase-admin";
import { SpeechClient } from "@google-cloud/speech";
import { VertexAI } from "@google-cloud/vertexai";
import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

/*──────────────────── CREDENCIALES GOOGLE CLOUD ───────────────────*/
try {
  console.log("Configurando credenciales de Google Cloud de forma programática...");
  
  // Intentar obtener las credenciales de diferentes variables de entorno
  let jsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || 
                   process.env.GOOGLE_CREDENTIALS_JSON || 
                   process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  
  if (!jsonString) {
    throw new Error("No se encontró ninguna variable de entorno con credenciales. Verificar GOOGLE_APPLICATION_CREDENTIALS_JSON, GOOGLE_CREDENTIALS_JSON o FIREBASE_SERVICE_ACCOUNT_KEY.");
  }
  
  console.log("✔️ Variable de credenciales encontrada, escribiendo archivo temporal...");
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

/*────────────────── ENV VARS Y CONFIGURACIÓN ───────────────────────*/
// URLs y secretos de n8n y supervisión (por defecto, se puede sobrescribir por bot)
const DEFAULT_N8N_REPORT_WEBHOOK_URL = "https://n8n.srv863010.hstgr.cloud/webhook/cbd9348c-7665-44a7-a2fc-eecbeb387b3c";
const DEFAULT_N8N_SUPERVISOR_WEBHOOK_URL = "https://n8n.srv863010.hstgr.cloud/webhook/fc528e23-f551-4cb0-a247-62063b4e4b40";
const SUPERVISOR_SECRET = "un_secreto_muy_largo_y_seguro_que_inventes";
const CALCOM_WEBHOOK_SECRET = "otro_secreto_muy_largo_y_seguro_que_inventes";

// Control de logging de herramientas (para debugging)
const ENABLE_TOOL_EXECUTION_LOGGING = process.env.ENABLE_TOOL_EXECUTION_LOGGING !== "false";
console.log(`[CONFIG] Logging detallado de herramientas: ${ENABLE_TOOL_EXECUTION_LOGGING ? "HABILITADO" : "DESHABILITADO"}`);
console.log(`[CONFIG] NOTA: Las herramientas se ejecutan DIRECTAMENTE como en el código original OpenAI`);

// Mapa de conexiones activas para supervisión
const activeConnections = new Map();

/*──────────────────── INICIALIZACIÓN DE SERVICIOS ───────────────────*/
let adminDb, speechClient, vertexAI, geminiModel, appCheck;

try {
  console.log("Inicializando servicios con credenciales configuradas...");

  // Inicializar Firebase Admin SDK con las credenciales configuradas
  let firebaseApp;
  try {
    // Verificar si ya existe una app inicializada
    firebaseApp = admin.app();
    console.log("✔️ Firebase app ya existe, reutilizando...");
  } catch (error) {
    // Si no existe, crear una nueva
    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountKey) {
      const serviceAccount = JSON.parse(serviceAccountKey);
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("✔️ Firebase Admin SDK inicializado con service account key.");
    } else {
      // Usar credenciales por defecto
      firebaseApp = admin.initializeApp();
      console.log("✔️ Firebase Admin SDK inicializado con credenciales por defecto.");
    }
  }
  
  adminDb = firebaseApp.firestore();
  appCheck = firebaseApp.appCheck();
  console.log("✔️ Firebase Firestore y AppCheck inicializados.");

  speechClient = new SpeechClient();
  console.log("✔️ SpeechClient inicializado.");

  vertexAI = new VertexAI({
    project: process.env.GOOGLE_PROJECT_ID || "botgpt-a284d",
    location: process.env.GOOGLE_LOCATION || "us-central1",
  });
  
  // Verificar que el modelo esté disponible
  try {
    geminiModel = vertexAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("✔️ VertexAI (Gemini 2.5 Flash) inicializado.");
  } catch (modelError) {
    console.warn("Modelo gemini-2.5-flash no disponible, intentando con gemini-pro...");
    try {
      geminiModel = vertexAI.getGenerativeModel({ model: "gemini-pro" });
      console.log("✔️ VertexAI (Gemini Pro) inicializado.");
    } catch (fallbackError) {
      throw new Error(`No se pudo inicializar ningún modelo de Gemini: ${fallbackError.message}`);
    }
  }

  console.log("✅ Todos los servicios se inicializaron correctamente.");
} catch (error) {
  console.error("CRITICAL: Fallo durante la inicialización de servicios.", error);
  console.error("Stack trace:", error.stack);
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

/*────────────────── UTILIDADES GEMINI Y HERRAMIENTAS ──────────────────*/
// Convierte tools estilo OpenAI → functionDeclarations de Gemini
function toVertexFunctionDeclarations(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }
  
  return tools
    .filter(t => t?.type === "function" && t.name)
    .map(t => ({
      name: t.name,
      description: t.description || "",
      parameters: {
        type: "object",
        properties: t.parameters?.properties || {},
        required: t.parameters?.required || []
      }
    }));
}

/**
 * Construye los handlers de herramientas para la conexión actual.
 * Cada WebSocket de cliente tendrá su propio juego de handlers con
 * el webhook que le corresponda.
 */
function buildToolHandlers(n8nWebhookUrl, getContext) {
  return {
    ejecutar_orden_n8n: async ({ orden }, meta = {}) => {
      const { conversationId, botId, fullConversation } = getContext();
      console.log(`[TOOL] ejecutar_orden_n8n → "${orden}" para ConversationID: ${conversationId}`);
      console.log(`[TOOL] Meta datos recibidos:`, JSON.stringify(meta, null, 2));
      console.log(`[TOOL] URL del webhook n8n: ${n8nWebhookUrl}`);

      if (!orden || typeof orden !== "string") {
        console.error(`[TOOL ERROR] Argumento orden inválido:`, { orden, type: typeof orden });
        return { status: "error", message: "Falta argumento «orden» (string)" };
      }
      if (!conversationId) {
        console.error("[TOOL ERROR] No se pudo obtener el conversationId.");
        return { status: "error", message: "Error interno: no se pudo encontrar el ID de la conversación." };
      }

      // Clave idempotente vinculada al tool call
      const dedupeKey = `${conversationId || 'no-conv'}::${botId || 'no-bot'}::${meta.responseId || 'no-resp'}::${meta.toolCallId || 'no-call'}`;
      console.log(`[TOOL] Clave de deduplicación: ${dedupeKey}`);

      // Registro idempotente en Firestore
      let alreadySent = false;
      try {
        await adminDb.runTransaction(async (tx) => {
          const ref = adminDb.collection("SentActions").doc(dedupeKey);
          const snap = await tx.get(ref);
          if (snap.exists) {
            alreadySent = true;
            return;
          }
          tx.set(ref, {
            createdAt: admin.firestore.Timestamp.now(),
            tipo: "ejecutar_orden_n8n",
            conversationId,
            botId,
            orden,
          });
        });
      } catch (e) {
        console.warn("[TOOL] Idempotency write failed (continuamos igualmente):", e.message);
      }
      if (alreadySent) {
        console.log(`[TOOL] Dedupe: orden YA enviada (dedupeKey=${dedupeKey}).`);
        return { status: "success", http_status: 200, response: "Duplicate suppressed (idempotent)" };
      }

      // Llamada a n8n con dedupeKey
      try {
        console.log(`[TOOL] Enviando petición a n8n...`);
        console.log(`[TOOL] URL del webhook de herramientas: ${n8nWebhookUrl}`);
        console.log(`[TOOL] Payload:`, JSON.stringify({ orden, conversationId, botId, fullConversation, dedupeKey }, null, 2));
        
        const resp = await fetch(n8nWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Dedupe-Key": dedupeKey
          },
          body: JSON.stringify({ orden, conversationId, botId, fullConversation, dedupeKey }),
          timeout: 15000,
        });

        console.log(`[TOOL] Respuesta de n8n - Status: ${resp.status}`);
        console.log(`[TOOL] Headers de respuesta:`, Object.fromEntries(resp.headers.entries()));

        const body = await resp.text();
        console.log(`[TOOL] Cuerpo de respuesta de n8n:`, body);

        const result = {
          status: resp.ok ? "success" : "error",
          http_status: resp.status,
          response: body,
        };
        
        console.log(`[TOOL] Resultado final de ejecutar_orden_n8n:`, JSON.stringify(result, null, 2));
        return result;
      } catch (err) {
        console.error("[TOOL ERROR] Error en llamada a n8n:", err);
        console.error("[TOOL ERROR] Stack trace:", err.stack);
        return { status: "error", message: err.message };
      }
    },
  };
}

function makeStandardSystemPrompt(botData, opts = {}) {
  const lang = (botData.language?.toLowerCase() === "en") ? "en" : "es";
  const hasN8n = !!opts?.hasN8n;
  const hasBooking = !!opts?.hasBooking;
  const persona = botData.Variable1 || (lang === "en" ? "a helpful virtual assistant" : "un asistente virtual útil");
  const firstLine = botData.Variable5 ? (lang === "en"
    ? `\nYour FIRST sentence must be EXACTLY: "${botData.Variable5}".`
    : `\nTu PRIMERA frase debe ser EXACTAMENTE: "${botData.Variable5}".`) : "";
  const specific = botData.Variable2 ? `\n\n${lang === "en" ? "### TASK-SPECIFIC INSTRUCTIONS" : "### INSTRUCCIONES ESPECÍFICAS DE LA TAREA"}\n${botData.Variable2}` : "";
  const accionesDesc = botData.accionesDescription || "";

  const core = (lang === "en") ? `
You are ${persona} for customer service. Be concise, direct and friendly. Always prioritize accuracy and ask only for what's strictly necessary to complete the task.

### Input Modality Notes
- If the user's message was typed, it will arrive preceded by "(Mensaje Escrito)". Treat it as **written** and reliable.
- Otherwise, assume it came by **voice** and may contain transcription errors.

### Data Policy (very important)
- **Email must be typed** by the user in the chat. If an email is dictated by voice, kindly ask them to type it to avoid transcription errors.
  - Example: "Got it. To make sure the email is 100% correct, could you please type it here?"
- **Other data** (name, phone, short notes) can be confirmed verbally. Repeat back and confirm: "I have 612 345 678. Is that correct?"

### Pragmatic Slot-Filling
- Before calling any tool, quickly list (mentally) the minimum fields required for the action.
- Only ask for strictly missing fields. Avoid long questionnaires.
- If a non-critical field is missing, proceed and note it as pending.

### Tool Execution Rules (CRITICAL)
1) **One tool per turn.** Never call multiple tools at once. Wait for the tool's result before deciding next steps.
2) **Announce & Act.** If you tell the user you're going to perform an action (save data, send email, open calendar), you MUST call the corresponding tool in the same turn.
3) **Handle tool responses privately.** Tool output is for you, not to be pasted to the user. If something fails or data is missing, apologize briefly and request just the missing piece.

${hasN8n ? `### External Tool: ejecutar_orden_n8n
- You have ONE messenger tool: \`ejecutar_orden_n8n\`. It delivers your natural-language **order** to a backend (n8n) that executes it.
- **Your job** is to craft a **clear, complete, self-contained order** with all required fields.
- Actions available (summary from config): "${accionesDesc}"

Good orders:
- \`Save the contact for Laura Fields with email laura.f@email.com and phone 612345678 for a family-law consultation.\`
- \`Send an email to j.perez@email.com with full information about the Business Retainer service.\`
- \`Register a callback request for Mark Soler (mark.s@email.com) tomorrow morning.\`

Bad orders:
- \`Save client data.\` (unclear)
- \`Send email.\` (no recipient/content)
` : ""}

${hasBooking ? `### Appointment Scheduling (Cal.com)
- When the user asks to schedule or check availability, use \`abrir_modal_agendamiento\`.
- Pass any known name, email (only if typed), and a short summary. Do not fabricate data.
- **Time confirmation:** When booking completes, confirm the **exact date/time received from the system** (do NOT reinterpret timezones). Speak it in the user's locale.
` : ""}

### Safety & Privacy
- Never invent emails/phones.
- Don't expose tool outputs verbatim to the user.
- If unsure, ask a short clarifying question rather than guessing.

### Corrections & Supervisor
- If the system injects a correction, apologize briefly, fix the information/action, and continue smoothly.

Be helpful, crisp, and get things done with minimal friction for the user.
${firstLine}
` : `
Eres ${persona} para atención al cliente. Sé conciso, directo y amable. Prioriza siempre la exactitud y pide solo lo **estrictamente necesario** para completar la tarea.

### Notas sobre la modalidad de entrada
- Si el mensaje del usuario llega precedido por "(Mensaje Escrito)", trátalo como **escrito** y fiable.
- En caso contrario, asume que vino por **voz** y puede contener errores de transcripción.

### Política de Datos (muy importante)
- **El email debe venir escrito** por el usuario en el chat. Si el email se dicta por voz, pídele amablemente que lo escriba para evitar errores.
  - Ejemplo: "Perfecto. Para asegurarnos de que el correo sea 100% correcto, ¿puedes escribirlo aquí, por favor?"
- **Otros datos** (nombre, teléfono, notas) pueden confirmarse verbalmente. Repite y confirma: "Tengo 612 345 678. ¿Es correcto?"

### Slot-Filling pragmático
- Antes de llamar a cualquier herramienta, lista mentalmente los campos mínimos requeridos para la acción.
- Pide únicamente lo que falte de forma imprescindible. Evita interrogatorios largos.
- Si falta un dato no crítico, continúa y anótalo como pendiente.

### Reglas de uso de herramientas (CRÍTICO)
1) **Una herramienta por turno.** No llames a varias a la vez. Espera la respuesta de la herramienta antes de decidir el siguiente paso.
2) **Anuncia y Actúa.** Si dices que vas a hacer algo (guardar datos, enviar email, abrir calendario), DEBES llamar a la herramienta correspondiente en ese mismo turno.
3) **Salida de herramienta = uso interno.** No pegues la salida técnica al usuario. Si falla o falta un dato, discúlpate brevemente y solicita solo lo que falte.

${hasN8n ? `### Herramienta externa: ejecutar_orden_n8n
- Dispones de UNA herramienta mensajera: \`ejecutar_orden_n8n\`. Envía tu **orden** en lenguaje natural a un backend (n8n) para que la ejecute.
- **Tu trabajo** es redactar una **orden clara, completa y autosuficiente** con todos los campos requeridos.
- Acciones disponibles (resumen de configuración): "${accionesDesc}"

Órdenes correctas:
- \`Guarda el contacto de Laura Campos con email laura.c@email.com y teléfono 612345678 para una consulta de derecho de familia.\`
- \`Envía un email a j.perez@email.com con la información completa sobre el servicio de Igualas para empresas.\`
- \`Registra una solicitud de llamada para Marcos Soler (marcos.s@email.com) mañana por la mañana.\`

Órdenes incorrectas:
- \`Guardar datos del cliente.\` (ambiguo)
- \`Enviar email.\` (sin destinatario/contenido)
` : ""}

${hasBooking ? `### Agendado de citas (Cal.com)
- Cuando el usuario quiera agendar o consultar disponibilidad, usa \`abrir_modal_agendamiento\`.
- Pasa nombre, email (solo si está escrito) y un breve resumen si lo tienes. No inventes datos.
- **Confirmación horaria:** Al confirmar, repite la **fecha/hora exacta que devuelve el sistema** (NO reinterpretes husos). Exprésala en español natural para el usuario.
` : ""}

### Seguridad y Privacidad
- No inventes emails/teléfonos.
- No muestres salidas técnicas de herramientas al usuario.
- Si hay duda, pregunta breve de aclaración en lugar de adivinar.

### Correcciones y Supervisor
- Si el sistema inyecta una corrección, discúlpate brevemente, corrige y continúa con fluidez. Si es una corrección por una herramienta mal ejecutada que puedes corregir, no te disculpas ni dices que estás corrigiendo nada, solo indicas que estás en proceso de realizar la acción y la vuelves a ejecutar correctamente según las indicaciones del supervisor.

Sé resolutivo, claro y minimiza la fricción para el usuario. Y no olvides pedir los datos del cliente: empresa nombre email y a ser posible teléfono. Y muy importante que procure darte los datos por escrito para evitar errores de transcripción, como mínimo el mail que te lo pase por escrito a través del campo de mensajes
${firstLine}
`;

  return core + specific;
}

/**
 * Envía datos de un turno de conversación al webhook supervisor de n8n.
 * Es una operación de "disparar y olvidar" que no bloquea el flujo principal.
 */
async function triggerSupervisorWorkflow(data, supervisorWebhookUrl = null) {
  const webhookUrl = supervisorWebhookUrl || DEFAULT_N8N_SUPERVISOR_WEBHOOK_URL;
  
  if (!webhookUrl) {
    return; // No hacer nada si la URL no está configurada
  }

  console.log(`[SUPERVISION] Disparando workflow para la conversación ${data.conversationId}...`);
  console.log(`[SUPERVISION] Datos del turno:`, JSON.stringify(data.currentTurn, null, 2));

  try {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      timeout: 10000,
    }).then(response => {
      if (response.ok) {
        console.log(`[SUPERVISION] Workflow para ${data.conversationId} disparado con éxito (Status: ${response.status}).`);
      } else {
        console.error(`[SUPERVISION ERROR] El webhook respondió con estado ${response.status} para ${data.conversationId}.`);
      }
    }).catch(error => {
      console.error(`[SUPERVISION ERROR] Fallo al contactar el webhook para ${data.conversationId}:`, error.message);
    });
  } catch (error) {
    console.error(`[SUPERVISION FATAL] Error al iniciar el fetch para la supervisión:`, error.message);
  }
}

/**
 * Envía la transcripción final al webhook de n8n para generar informes.
 */
async function triggerReportWorkflow(convId, transcript, reportWebhookUrl = null) {
  const webhookUrl = reportWebhookUrl || DEFAULT_N8N_REPORT_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.log("[N8N REPORT] El webhook de informes no está configurado. Omitiendo.");
    return;
  }

  console.log(`[N8N REPORT] Disparando workflow para la conversación ${convId}...`);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: convId,
        transcript: transcript.trim(),
      }),
      timeout: 5000,
    });

    if (response.ok) {
      console.log(`[N8N REPORT] Workflow para ${convId} disparado con éxito.`);
    } else {
      console.error(`[N8N REPORT ERROR] El webhook respondió con estado ${response.status} para ${convId}.`);
    }
  } catch (error) {
    console.error(`[N8N REPORT ERROR] Fallo al contactar el webhook para ${convId}:`, error.message);
  }
}

/*────────────────── WEBSOCKET /realtime-ws ──────────────────*/
app.ws("/realtime-ws", (clientWs) => {
  console.log("[CLIENT CONNECTED]");
  
  // Estado STT
  let recognizeStream = null;
  let sttLanguageCode = "es-ES";
  
  // Estado Gemini y conversación
  let geminiChat = null;
  let lastFinalNorm = "";
  
  // Estado de herramientas y supervisión
  let currentTools = [];
  let toolHandlers = {};
  let isSupervised = false;
  let conversationId = null;
  let conversationCreated = false;
  let currentBotId = null;
  let currentUserId = null;
  let currentCreadorBot = null;
  let currentFacturaADestinatario = false;
  let fullConversationTranscript = "";
  let currentUserTranscript = "";
  let currentUserInputSource = "voice";
  let isCorrecting = false;
  
  // Webhooks específicos del bot
  let currentN8nWebhook = "";
  let currentSupervisorWebhook = "";
  let currentReportWebhook = "";
  
  // Estados para deduplicación de herramientas
  const seenToolCalls = new Set();
  let isPausedForUserAction = false;

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

    const request = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 24000,
        languageCode: sttLanguageCode,
        model: "latest_long",
        enableAutomaticPunctuation: true,
        maxAlternatives: 1,
      },
      interimResults: true,
    };

    endStt("restart");

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

  // Helper para enviar assistant_final y persistir transcript
  async function commitAssistantFinal(text, { supervise = true } = {}) {
    const final = (text || "").trim();
    if (!final) return;

    // Emitir al cliente
    safeSend(clientWs, { type: "assistant_final", text: final });

    // Persistencia en transcript
    fullConversationTranscript += `\nAI-BOT: ${final}`;
    try {
      if (conversationId && conversationCreated) {
        await adminDb
          .collection("Conversations")
          .doc(conversationId)
          .update({
            BotTranscripcion: fullConversationTranscript,
            Timestamp: admin.firestore.Timestamp.now(),
          });
      }
    } catch (e) {
      console.warn("[DB WARN] No se pudo guardar transcript:", e.message);
    }

    // Supervisión opcional
    if (supervise && isSupervised && !isCorrecting) {
      triggerSupervisorWorkflow(
        {
          botId: currentBotId,
          conversationId,
          fullConversation: fullConversationTranscript,
          currentTurn: {
            userInput: currentUserTranscript,
            userInputSource: currentUserInputSource,
            botResponse: final,
            toolCall: null,
          },
        },
        currentSupervisorWebhook
      );
    }

    // Limpieza de flags de turno de usuario
    currentUserTranscript = "";
    isCorrecting = false;
  }

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
        if (norm && norm !== lastFinalNorm) {
          lastFinalNorm = norm;
          currentUserTranscript = norm;
          currentUserInputSource = "voice";
          
          // Añadir a transcripción completa
          const userTurnString = `\nUSUARIO (por voz): ${norm}`;
          fullConversationTranscript += userTurnString;
          
          // Persistir en Firestore
          if (conversationId && conversationCreated) {
            adminDb.collection("Conversations").doc(conversationId)
              .update({ BotTranscripcion: fullConversationTranscript })
              .catch(err => console.error("[DB ERROR] Al guardar transcripción:", err));
          }
          
          await getGeminiResponse(norm);
        }
      }
    } catch (e) {
      console.error("[onSpeechData ERROR]", e);
    }
  }

  async function getGeminiResponse(userText) {
    if (!geminiChat) return;

    // 🚨 CRÍTICO: Si está pausado para acción de usuario, ignorar completamente (igual que OpenAI)
    if (isPausedForUserAction) {
      console.log("⏸️ [GEMINI] Conversación pausada para acción de usuario. Ignorando input.");
      return;
    }

    let fullText = "";
    let toolAlreadyHandledThisTurn = false;

    try {
      const result = await geminiChat.sendMessageStream(userText || " ");

      for await (const chunk of result.stream) {
        // Verificar que chunk existe y tiene candidates
        if (!chunk || typeof chunk !== 'object') {
          console.warn("[GEMINI] Chunk inválido:", chunk);
          continue;
        }

        // Verificar finishReason y blockedReason para debugging
        if (chunk.finishReason) {
          console.log(`[GEMINI] Finish reason: ${chunk.finishReason}`);
        }
        if (chunk.blockedReason) {
          console.warn(`[GEMINI] Blocked reason: ${chunk.blockedReason}`);
        }

        const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
        
        for (const cand of candidates) {
          // Verificar finishReason del candidato
          if (cand.finishReason) {
            console.log(`[GEMINI] Candidate finish reason: ${cand.finishReason}`);
          }
          
          // Verificar que el candidato tiene content y parts
          if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
            console.warn("[GEMINI] Candidato sin parts válidas:", cand);
            continue;
          }

          const parts = cand.content.parts;
          
          for (const part of parts) {
            // Texto del asistente (delta)
            if (part && typeof part.text === "string" && part.text.length > 0) {
              fullText += part.text;
              safeSend(clientWs, { type: "assistant_delta", delta: part.text });
            }

            // Llamada a herramienta (functionCall)
            // Nota: Los modelos 2.5 soportan parallel function calling
            // pero mantenemos política de "una por turno"
            if (part && part.functionCall && !toolAlreadyHandledThisTurn) {
              toolAlreadyHandledThisTurn = true;

              // ✅ CLAVE: cerrar el texto acumulado ANTES de ejecutar la tool
              if (fullText.trim()) {
                // No supervisamos este cierre pre-tool para evitar duplicación
                // ya que la herramienta será reportada por separado
                await commitAssistantFinal(fullText, { supervise: false });
                fullText = ""; // Limpiar para evitar reutilización
              }

              const fc = part.functionCall;
              console.log("[GEMINI] Function call detectada:", JSON.stringify(fc, null, 2));
              
              // Si hubiera múltiples function calls en el mismo candidate,
              // aparecerían como parts adicionales con functionCall
              // Por política actual, procesamos solo la primera
              await handleFunctionCall(fc);
              // Retornar aquí es correcto - la lógica post-tool está en handleFunctionCall
              return;
            }
          }
        }
      }

      // Fin del stream sin tools → cierre normal con supervisión
      await commitAssistantFinal(fullText, { supervise: true });
    } catch (error) {
      console.error("[GEMINI API ERROR]", error);
      safeSend(clientWs, { type: "error", message: `Error en la API de Gemini: ${error.message}` });
    }
  }

  async function handleFunctionCall(functionCall) {
    try {
      console.log("[TOOLS] Procesando function call:", JSON.stringify(functionCall, null, 2));
      
      const name = functionCall.name;
      let args = {};
      
      // Manejar diferentes formatos de argumentos
      if (functionCall.args) {
        if (typeof functionCall.args === "object" && functionCall.args !== null) {
          args = functionCall.args;
        } else if (typeof functionCall.args === "string") {
          try {
            args = JSON.parse(functionCall.args);
          } catch (parseError) {
            console.warn("[TOOLS] No se pudieron parsear los argumentos como JSON:", functionCall.arguments);
            args = {};
          }
        }
      }

      console.log("[TOOLS] Argumentos procesados:", JSON.stringify(args, null, 2));

      // Dedupe
      const key = `${name}::${JSON.stringify(args)}`;
      if (seenToolCalls.has(key)) {
        console.log("[TOOLS] Llamada duplicada ignorada:", key);
        return;
      }
      seenToolCalls.add(key);

      // Aviso al front
      safeSend(clientWs, { type: "tool_execution_start", toolName: name });

      // EJECUTAR HERRAMIENTA DIRECTAMENTE (sin validación previa como en el código original)
      console.log(`[TOOLS] Ejecutando herramienta directamente: ${name}`);

      if (!toolHandlers[name]) {
        const err = { status: "error", message: `La herramienta «${name}» no existe.` };
        console.error(`[TOOL ERROR] Herramienta inexistente: ${name}`);
        await sendFunctionResponseToGemini(name, err);
        safeSend(clientWs, { type: "tool_execution_end", toolName: name, success: false });
        await streamFollowUpAfterTool();
        return;
      }

      // Ejecuta herramienta real
      console.log(`[TOOL EXECUTION] Iniciando ejecución de herramienta: ${name}`);
      console.log(`[TOOL EXECUTION] Argumentos para ${name}:`, JSON.stringify(args, null, 2));
      
      const result = await toolHandlers[name](args, { toolCallId: crypto.randomUUID?.() || Date.now().toString() });
      
      console.log(`[TOOL EXECUTION] Resultado de ${name}:`, JSON.stringify(result, null, 2));
      safeSend(clientWs, { type: "tool_execution_end", toolName: name, success: result?.status === "success" });

      // Entregar la salida de la herramienta al modelo (functionResponse)
      await sendFunctionResponseToGemini(name, result);

      // Actualizar transcript con ejecución de herramienta
      const toolExecutionString = `\nEjecución De Herramienta Por Parte Del Agente: ${name}(${JSON.stringify(args)}) - Resultado: ${result?.status || 'unknown'}`;
      fullConversationTranscript += toolExecutionString;

      if (conversationId && conversationCreated) {
        const convRef = adminDb.collection("Conversations").doc(conversationId);
        convRef.update({ BotTranscripcion: fullConversationTranscript })
          .catch(err => console.error("[DB ERROR] Al comitear transcript con tool:", err));
      }

      // Reporte al supervisor de este turno con herramienta
      if (isSupervised && !isCorrecting) {
        triggerSupervisorWorkflow({
          botId: currentBotId,
          conversationId,
          fullConversation: fullConversationTranscript,
          currentTurn: {
            userInput: currentUserTranscript,
            userInputSource: currentUserInputSource,
            botResponse: null,
            toolCall: { name, arguments: args, result }
          }
        }, currentSupervisorWebhook);
      }

      // Limpieza para siguiente turno
      currentUserTranscript = "";
      isCorrecting = false;

      // Solo para herramientas que NO son de agendamiento, generar réplica post-tool
      if (name !== "abrir_modal_agendamiento") {
        // Pasar información sobre el éxito de la herramienta
        await streamFollowUpAfterTool(result?.status === "success", name, args.orden);
      } else {
        // 🚨 CRÍTICO: Para agendamiento, la pausa ya se estableció en el handler
        console.log(`[TOOL_FLOW] Agendamiento completado. Pausa ya establecida por el handler.`);
      }

    } catch (err) {
      console.error("[TOOL-FLOW ERROR]", err);
      safeSend(clientWs, { type: "tool_execution_end", toolName: functionCall?.name || "herramienta", success: false });
      await sendFunctionResponseToGemini(functionCall?.name || "unknown_tool", { status: "error", message: err.message });
      await streamFollowUpAfterTool();
    } finally {
      // limpiar dedupe por turno
      seenToolCalls.clear();
    }
  }

  async function sendFunctionResponseToGemini(name, payload) {
    try {
      // Formato correcto para Vertex AI Gemini según documentación actual
      // El response debe incluir { name, content } según SDK de Node
      const functionResponseParts = [{
        functionResponse: {
          name: name,
          response: {
            name: name,
            content: payload
          }
        }
      }];
      
      const result = await geminiChat.sendMessage(functionResponseParts);
      console.log(`[TOOLS] Respuesta enviada a Gemini para herramienta ${name}`);
      
      return result;
    } catch (error) {
      console.error("[TOOLS] Error enviando respuesta a Gemini:", error);
      // Fallback: enviar como mensaje de texto simple
      try {
        const fallbackMessage = `El resultado de la herramienta ${name} fue: ${JSON.stringify(payload)}`;
        await geminiChat.sendMessage([{text: fallbackMessage}]);
        console.log(`[TOOLS] Fallback exitoso para herramienta ${name}`);
      } catch (fallbackError) {
        console.error("[TOOLS] Error en fallback también:", fallbackError);
      }
    }
  }

  async function streamFollowUpAfterTool(wasSuccessful = false, toolName = "", actionPerformed = "") {
    // 🚨 CRÍTICO: Para agendamiento NO generar follow-up, igual que OpenAI
    if (toolName === "abrir_modal_agendamiento") {
      console.log(`[TOOL_FLOW] Agendamiento ejecutado. No se genera follow-up (backend pausado).`);
      return;
    }

    let followText = "";
    try {
      // Si la herramienta fue exitosa, agregar contexto de confirmación
      let promptMessage = "";
      if (wasSuccessful && actionPerformed) {
        promptMessage = `La acción "${actionPerformed}" se ha completado exitosamente. Confirma al usuario que se realizó correctamente y continúa la conversación naturalmente.`;
        console.log(`[GEMINI FOLLOW] Enviando contexto de éxito: ${promptMessage}`);
      }
      
      const follow = await geminiChat.sendMessageStream(promptMessage); // trigger del turno post-herramienta
      
      for await (const chunk of follow.stream) {
        // Verificar que chunk existe y tiene candidates
        if (!chunk || typeof chunk !== 'object') {
          console.warn("[GEMINI FOLLOW] Chunk inválido:", chunk);
          continue;
        }

        // Verificar finishReason y blockedReason para debugging
        if (chunk.finishReason) {
          console.log(`[GEMINI FOLLOW] Finish reason: ${chunk.finishReason}`);
        }
        if (chunk.blockedReason) {
          console.warn(`[GEMINI FOLLOW] Blocked reason: ${chunk.blockedReason}`);
        }

        const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
        
        for (const cand of candidates) {
          // Verificar finishReason del candidato
          if (cand.finishReason) {
            console.log(`[GEMINI FOLLOW] Candidate finish reason: ${cand.finishReason}`);
          }
          
          // Verificar que el candidato tiene content y parts
          if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
            console.warn("[GEMINI FOLLOW] Candidato sin parts válidas:", cand);
            continue;
          }

          const parts = cand.content.parts;
          
          for (const part of parts) {
            if (part && typeof part.text === "string" && part.text.length > 0) {
              followText += part.text;
              safeSend(clientWs, { type: "assistant_delta", delta: part.text });
            }
          }
        }
      }
      
      // Fin del stream post-tool → usar commitAssistantFinal para consistencia
      await commitAssistantFinal(followText, { supervise: false });
    } catch (error) {
      console.error("[GEMINI FOLLOW ERROR]", error);
      safeSend(clientWs, { type: "error", message: `Error en seguimiento post-tool: ${error.message}` });
    }
  }

  /**
   * Aplica una corrección proveniente del supervisor.
   */
  async function applyCorrection(correctionMessage) {
    try {
      if (!conversationId) {
        console.warn('[CORRECTION] Se recibió corrección sin conversationId. Ignorada.');
        return;
      }

      console.log(`[CORRECTION] Aplicando corrección para ${conversationId}: "${correctionMessage}"`);
      const supervisorTurnString = `\nSUPERVISOR: ${correctionMessage}`;
      fullConversationTranscript += supervisorTurnString;

      // Persistimos de forma transaccional
      const convDocRef = adminDb.collection('Conversations').doc(conversationId);
      try {
        await adminDb.runTransaction(async (tx) => {
          const snap = await tx.get(convDocRef);
          if (!snap.exists) throw new Error('Conversation doc no existe para corrección.');
          const oldT = snap.data().BotTranscripcion || '';
          tx.update(convDocRef, {
            BotTranscripcion: oldT + supervisorTurnString,
            Timestamp: admin.firestore.Timestamp.now(),
          });
        });
        console.log(`[DB OK] Corrección guardada para ${conversationId}.`);
      } catch (dbErr) {
        console.error('[DB ERROR] Fallo guardando corrección:', dbErr);
      }

      // Marcamos flag para evitar doble supervisión inmediata
      isCorrecting = true;
      console.log('[FLAG] isCorrecting = true');

      // Prompt de corrección para Gemini
      const finalCorrectionPrompt = `
      INSTRUCCIÓN DE CORRECCIÓN URGENTE:
      Tu respuesta anterior contenía un error que ha sido detectado por tu sistema de supervisión interno.
      Tu tarea AHORA es generar una nueva respuesta al usuario donde hagas lo siguiente, en este orden:
      1. Discúlpate amablemente por la confusión o el error en tu mensaje anterior. Puedes mencionar que tu sistema lo ha detectado para ser transparente.
      2. Proporciona la información correcta o realiza la acción correcta basándote en la siguiente directiva de tu supervisor: "${correctionMessage}"
      3. Continúa la conversación de forma natural después de haber corregido el error.
      4. MUY IMPORTANTE: Todo lo anterior es solo para respuestas equivocadas y corregidas por el supervisor: Si el error corresponde a una ejecución incorrecta de una herramienta, no digas que estás corrigiendo nada, simplemente indica que estás en proceso de realizar la acción y vuelve a ejecutarla correctamente según las indicaciones del supervisor.
    `;

      // Inyectamos mensaje de sistema y pedimos nueva respuesta
      await geminiChat.sendMessage([{
        text: finalCorrectionPrompt
      }]);
      
      await getGeminiResponse("");
      console.log('[CORRECTION] Mensaje de corrección enviado a Gemini.');
    } catch (err) {
      console.error('[CORRECTION FATAL] Error aplicando corrección:', err);
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
            if (!msg.appCheckToken) throw new Error("Falta AppCheck token");
            await appCheck.verifyToken(msg.appCheckToken);
            
            currentUserId = msg.interactingUserId;
            currentBotId = msg.botId;
            if (!currentUserId || !currentBotId) throw new Error("Faltan IDs de usuario o bot.");
            
            const botSnap = await adminDb.collection("InteracBotGPT").doc(currentBotId).get();
            if (!botSnap.exists) throw new Error(`Bot ${currentBotId} no encontrado.`);
            const botData = botSnap.data();

            isSupervised = botData.supervised === true;
            console.log(`[CONFIG] Estado de supervisión para bot ${currentBotId}: ${isSupervised}`);

            currentCreadorBot = botData.userId;
            currentN8nWebhook = botData.n8nWebhookUrl || "";
            
            // Configurar webhooks específicos del bot (con fallback a los por defecto)
            currentSupervisorWebhook = botData.supervisorWebhookUrl || DEFAULT_N8N_SUPERVISOR_WEBHOOK_URL;
            currentReportWebhook = botData.reportWebhookUrl || DEFAULT_N8N_REPORT_WEBHOOK_URL;
            
            console.log(`[CONFIG] Webhooks para bot ${currentBotId}:`);
            console.log(`[CONFIG] - N8N Herramientas: ${currentN8nWebhook || "No configurado"}`);
            console.log(`[CONFIG] - N8N Supervisor: ${currentSupervisorWebhook}`);
            console.log(`[CONFIG] - N8N Reports: ${currentReportWebhook}`);
            
            const bookingUrl = botData.book?.calendlyUrl || null;
            const sistemaAgendado = botData.book?.sistemaAgendado === true;
            currentFacturaADestinatario = !!botData.facturaADestinatario;

            // Configurar herramientas
            currentTools = [];
            toolHandlers = {};

            if (currentN8nWebhook) {
              currentTools.push({
                type: "function",
                name: "ejecutar_orden_n8n",
                description: "Envía una orden en texto libre al workflow de n8n para ejecutar la acción solicitada.",
                parameters: {
                  type: "object",
                  properties: { orden: { type: "string", description: "Instrucción completa en lenguaje natural." } },
                  required: ["orden"]
                }
              });
              toolHandlers = buildToolHandlers(currentN8nWebhook, () => ({
                conversationId: conversationId,
                botId: currentBotId,
                fullConversation: fullConversationTranscript
              }));
            }

            if (sistemaAgendado && bookingUrl) {
              console.log(`[CONFIG] Sistema de agendamiento (Cal.com) activado para bot ${currentBotId}.`);
              currentTools.push({
                type: "function",
                name: "abrir_modal_agendamiento",
                description: "Abre la interfaz de calendario para que el usuario agende una cita. Debes pasar el nombre, email y un resumen del caso si los tienes disponibles.",
                parameters: {
                  type: "object",
                  properties: {
                    nombre: { type: "string", description: "Nombre completo del usuario que has recopilado." },
                    email: { type: "string", description: "Email del usuario que has recopilado." },
                    resumen: { type: "string", description: "Un breve resumen del caso que ya conozcas." }
                  }
                }
              });

              toolHandlers.abrir_modal_agendamiento = async ({ nombre, email, resumen }) => {
                try {
                  const urlObj = new URL(bookingUrl);

                  if (nombre) urlObj.searchParams.set('name', nombre);
                  if (email) urlObj.searchParams.set('email', email);
                  if (resumen) urlObj.searchParams.set('notes', resumen);
                  if (conversationId) urlObj.searchParams.set('metadata[convoId]', conversationId);
                  urlObj.searchParams.set('embed', '1');

                  const finalUrl = urlObj.toString();
                  console.log(`[TOOL] URL final de Cal.com: ${finalUrl}`);

                  if (clientWs && clientWs.readyState === WS_OPEN) {
                    safeSend(clientWs, { type: 'schedule_appointment_action', url: finalUrl });
                    // 🚨 CRÍTICO: Establecer pausa EXACTAMENTE como en OpenAI
                    isPausedForUserAction = true;
                    console.log(`[TOOL_FLOW] Pausa iniciada para agendamiento. Backend espera.`);
                    return { status: "success", message: "Modal de agendamiento solicitado." };
                  }

                  return { status: "error", message: "No se pudo contactar al cliente para abrir el calendario." };
                } catch (err) {
                  console.error("[TOOL abrir_modal_agendamiento ERROR]", err);
                  return { status: "error", message: `Error construyendo URL de Cal.com: ${err.message}` };
                }
              };
            }

            // Configurar prompt del sistema
            const lang = botData.language?.toLowerCase() === "en" ? "en" : "es";
            const tieneN8n = !!currentN8nWebhook;
            const systemPrompt = makeStandardSystemPrompt(botData, {
              hasN8n: tieneN8n,
              hasBooking: (sistemaAgendado && bookingUrl),
              language: lang
            });

            // Iniciar chat de Gemini con herramientas
            const functionDeclarations = toVertexFunctionDeclarations(currentTools);
            
            let chatConfig = {
              systemInstruction: {
                parts: [{ text: systemPrompt }]
              }
            };
            
            if (functionDeclarations && functionDeclarations.length > 0) {
              // Declaraciones de herramientas
              chatConfig.tools = [{
                functionDeclarations: functionDeclarations
              }];

              // Permitir alternar el modo por ENV (AUTO por defecto)
              const FUNCTION_CALL_MODE = (process.env.GEMINI_FUNCTION_CALL_MODE || 'AUTO').toUpperCase();
              const allowedNames = functionDeclarations.map(f => f.name);

              // Construcción correcta según documentación:
              // - AUTO: NO se permite allowedFunctionNames
              // - ANY : Puedes (opcionalmente) pasar allowedFunctionNames
              if (FUNCTION_CALL_MODE === 'ANY') {
                chatConfig.toolConfig = {
                  functionCallingConfig: {
                    mode: 'ANY',
                    // puedes restringir a las funciones permitidas:
                    allowedFunctionNames: allowedNames
                  }
                };
                console.log(`[GEMINI] ToolConfig mode=ANY, allowed functions:`, allowedNames);
              } else if (FUNCTION_CALL_MODE === 'NONE') {
                chatConfig.toolConfig = {
                  functionCallingConfig: { mode: 'NONE' }
                };
                console.log(`[GEMINI] ToolConfig mode=NONE (prohibidas las tools)`);
              } else {
                // AUTO (por defecto) → sin allowedFunctionNames
                chatConfig.toolConfig = {
                  functionCallingConfig: { mode: 'AUTO' }
                };
                console.log(`[GEMINI] ToolConfig mode=AUTO (sin allowedFunctionNames)`);
              }

              console.log(`[GEMINI] Inicializando chat con ${functionDeclarations.length} herramientas:`, allowedNames);
            } else {
              console.log("[GEMINI] Inicializando chat sin herramientas");
            }

            try {
              geminiChat = geminiModel.startChat(chatConfig);
              console.log("[GEMINI] Chat inicializado correctamente");
            } catch (chatError) {
              console.error("[GEMINI] Error inicializando chat:", chatError);
              // Fallback: inicializar sin herramientas
              geminiChat = geminiModel.startChat({
                systemInstruction: {
                  parts: [{ text: systemPrompt }]
                }
              });
              console.log("[GEMINI] Chat inicializado en modo fallback (sin herramientas)");
            }

            // Crear documento de conversación
            if (!conversationId) {
              const convRef = await adminDb.collection("Conversations").add({
                RobotId: currentBotId,
                StartTime: admin.firestore.Timestamp.now(),
                Timestamp: admin.firestore.Timestamp.now(),
                BotTranscripcion: "",
                BotInforme: "",
                UserName: msg.userName || "",
                UserEmail: msg.userEmail || "",
                UserId: currentUserId,
                CreadorBot: currentCreadorBot,
                MinutosUsoConv: 0
              });
              conversationId = convRef.id;
              conversationCreated = true;
              console.log(`[DB] Conversación creada: ${conversationId}`);

              // Registrar conexión para correcciones
              // === Estado de deduplicación de reservas por conexión ===
              let lastBookingIdProcessed = null;
              let lastBookingStartISO = null;
              let bookingAnnouncedTs = 0;

              activeConnections.set(conversationId, {
                applyCorrection: (msg) => applyCorrection(msg),
                resumeWithBookingData: async (eventDetails) => {
                  try {
                    console.log("🗓️ [BOOKING] Webhook Cal.com recibido → procesar");

                    const bookingId =
                      eventDetails?.id ||
                      eventDetails?.uid ||
                      eventDetails?.bookingId ||
                      eventDetails?.booking?.id ||
                      null;

                    const rawStartISO = eventDetails?.startTime || eventDetails?.start?.time || null;
                    const startISO = rawStartISO ? String(rawStartISO) : null;

                    // Ventanas de deduplicación
                    const now = Date.now();
                    const NEAR_WINDOW_MS = 5 * 60 * 1000; // ±5 minutos
                    const ANTI_DUP_MS = 10 * 1000;        // 10 segundos

                    if (bookingId && lastBookingIdProcessed && bookingId === lastBookingIdProcessed) {
                      console.log("🔁 [BOOKING] Duplicado por bookingId. Ignorado.");
                      return;
                    }
                    if (!bookingId && startISO && lastBookingStartISO) {
                      const t1 = new Date(startISO).getTime();
                      const t2 = new Date(lastBookingStartISO).getTime();
                      if (Math.abs(t1 - t2) <= NEAR_WINDOW_MS && (now - bookingAnnouncedTs) < ANTI_DUP_MS) {
                        console.log("🔁 [BOOKING] Duplicado por ventana temporal (sin id). Ignorado.");
                        return;
                      }
                    }

                    // Notificar al frontend (idempotente)
                    if (clientWs && clientWs.readyState === 1) {
                      safeSend(clientWs, {
                        type: "booking_completed",
                        details: {
                          startTime:   startISO,
                          endTime:     eventDetails?.endTime   || eventDetails?.end?.time   || null,
                          title:       eventDetails?.title || eventDetails?.eventType?.title || "Tu cita",
                          inviteeName: eventDetails?.attendees?.[0]?.name  || eventDetails?.name  || "",
                          inviteeEmail:eventDetails?.attendees?.[0]?.email || eventDetails?.email || "",
                          timeZone:    eventDetails?.timeZone || eventDetails?.attendees?.[0]?.timeZone || "Europe/Madrid"
                        }
                      });
                    }

                    // ⬅️ CAMBIO CRÍTICO: despausar ANTES de enviar a Gemini
                    if (isPausedForUserAction) {
                      isPausedForUserAction = false;
                      console.log("✅ [BOOKING] Conversación reanudada (estaba en pausa).");
                    } else {
                      console.log("ℹ️ [BOOKING] Conversación ya despausada; anuncio idempotente enviado.");
                    }

                    const title = eventDetails?.title || eventDetails?.eventType?.title || "Tu cita";
                    const startDate = startISO ? new Date(startISO) : null;
                    const esES_Madrid = new Intl.DateTimeFormat('es-ES', {
                      timeZone: 'Europe/Madrid',
                      dateStyle: 'full',
                      timeStyle: 'short'
                    });
                    const fechaLegible = startDate ? esES_Madrid.format(startDate) : null;

                    const systemText = `INSTRUCCIÓN: El usuario acaba de agendar una cita con éxito.${fechaLegible ? ` Detalles: "${title}" para el ${fechaLegible}.` : ""}\n1) Confirma verbalmente la cita${fechaLegible ? " mencionando día y hora" : ""}.\n2) Indica que recibirá un email del sistema con el enlace a Google Meet para la videoconferencia y que le permite añadir la cita a su calendario.\n3) Pregunta si necesita algo más.`;

                    await geminiChat.sendMessage([{
                      text: systemText
                    }]);
                    await getGeminiResponse("");

                    if (bookingId) lastBookingIdProcessed = bookingId;
                    if (startISO) lastBookingStartISO = startISO;
                    bookingAnnouncedTs = now;

                    console.log(`[BOOKING] Anunciado booking ${bookingId || "(sin id)"} inicio ${startISO || "(desconocido)"}.`);
                  } catch (err) {
                    console.error("[RESUME ERROR]", err);
                  }
                }
              });
              console.log(`[CONN_MAP] Conexión para ${conversationId} registrada.`);
            }

            safeSend(clientWs, { type: "info", message: "Backend conectado y listo." });
            await getGeminiResponse(""); // saludo inicial

          } catch (e) {
            console.error("[START_CONV ERROR]", e);
            safeSend(clientWs, { type: "error", message: e.message });
          }
          break;
        }

        case "user_action_pending":
          console.log("🛑 Pausando conversación - usuario en calendario");
          isPausedForUserAction = true;
          break;

        case "user_action_completed": {
          console.log(`[DEBUG] Recibido user_action_completed. isPausedForUserAction: ${isPausedForUserAction}`);
          if (!isPausedForUserAction) {
            console.log("⚠️ Recibido user_action_completed pero no estaba pausado para acción de usuario. IGNORANDO completamente.");
            break;
          }

          isPausedForUserAction = false;

          let systemText;
          
          // PRIORIDAD 1: si el front nos manda appointmentData, úsalo y listo (idempotente)
          if (msg.appointmentData && (msg.appointmentData.startTime || (msg.appointmentData.start && msg.appointmentData.start.time))) {
            const startISO = msg.appointmentData.startTime || msg.appointmentData.start?.time || null;
            const title = msg.appointmentData.eventName || msg.appointmentData.title || "Tu cita";
            const fechaLegible = startISO
              ? new Date(startISO).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short' })
              : null;

            systemText = fechaLegible
              ? `INSTRUCCIÓN: El usuario acaba de agendar una cita con éxito. Detalles: "${title}" para el ${fechaLegible}.
1) Confirma verbalmente la cita mencionando día y hora.
2) Indica que recibirá un email con los detalles.
3) Pregunta si necesita algo más.`
              : `INSTRUCCIÓN: El usuario acaba de agendar una cita con éxito.
1) Confirma verbalmente la cita.
2) Indica que recibirá un email con los detalles.
3) Pregunta si necesita algo más.`;

          } else {
            // PRIORIDAD 2: compat con el flujo antiguo (Firestore PendingBookingEvents)
            try {
              const bookingEventRef = adminDb.collection("Conversations").doc(conversationId).collection("PendingBookingEvents").doc("latest");
              const bookingEventSnap = await bookingEventRef.get();

              if (bookingEventSnap.exists) {
                console.log(`[RESUME] ¡Reserva encontrada para ${conversationId}!`);
                const bookingData = bookingEventSnap.data();
                
                // CAMBIO CRÍTICO: Verificar que tenemos startTime y formatearlo correctamente
                console.log(`[RESUME] Datos de la reserva:`, JSON.stringify(bookingData, null, 2));
                
                if (bookingData.startTime) {
                  // Convertir Firestore Timestamp a Date si es necesario
                  let startDate;
                  if (bookingData.startTime.toDate) {
                    // Es un Firestore Timestamp
                    startDate = bookingData.startTime.toDate();
                  } else if (typeof bookingData.startTime === 'string') {
                    // Es una string ISO
                    startDate = new Date(bookingData.startTime);
                  } else {
                    // Asumir que ya es un Date
                    startDate = new Date(bookingData.startTime);
                  }
                  
                  const formattedDate = startDate.toLocaleString('es-ES', { 
                    dateStyle: 'full', 
                    timeStyle: 'short',
                    timeZone: 'Europe/Madrid'
                  });
                  
                  const title = bookingData.title || "Tu cita";
                  
                  systemText = `INSTRUCCIÓN: El usuario acaba de agendar una cita con éxito. Los detalles son: "${title}" para el ${formattedDate}.
1) Confirma verbalmente la cita mencionando día y hora.
2) Indica que recibirá un email del sistema con el enlace a Google Meet para la videoconferencia y que le permite añadir la cita a su calendario.
3) Pregunta si necesita algo más.`;
                  
                  console.log(`[RESUME] Mensaje de confirmación preparado: ${systemText}`);
                } else {
                  console.warn(`[RESUME] Reserva encontrada pero sin startTime válido:`, bookingData);
                  systemText = `INSTRUCCIÓN: El usuario acaba de agendar una cita con éxito.
1) Confirma verbalmente la cita.
2) Indica que recibirá un email del sistema con los detalles.
3) Pregunta si necesita algo más.`;
                }

                await bookingEventRef.delete();
                console.log(`[DB OK] Evento de reserva procesado y eliminado para ${conversationId}.`);
              } else {
                console.log(`[RESUME] No se encontró reserva para ${conversationId}. El usuario cerró el modal.`);
                systemText = "El usuario ha cerrado el calendario sin agendar una cita. Pregúntale amablemente si necesita algo más o si quiere intentarlo de nuevo.";
              }
            } catch (error) {
              console.error(`[RESUME ERROR] Fallo al buscar evento de reserva para ${conversationId}:`, error);
              systemText = "El usuario ha cerrado la ventana de agendamiento. Pregúntale si puedes ayudarle en algo más.";
            }
          }

          // Inyectar y responder CON GEMINI (no OpenAI)
          console.log(`[RESUME] Enviando mensaje de sistema a Gemini: ${systemText}`);
          await geminiChat.sendMessage([{
            text: systemText
          }]);
          console.log(`[DEBUG] Mensaje de sistema enviado. Ahora generando respuesta automática...`);

          // CAMBIO CRÍTICO: Generar respuesta automática sin input de usuario
          // Similar a como funciona streamFollowUpAfterTool para otras herramientas
          try {
            const result = await geminiChat.sendMessageStream(""); // Stream vacío para trigger automático
            
            let fullText = "";
            for await (const chunk of result.stream) {
              if (!chunk || typeof chunk !== 'object') continue;

              const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
              
              for (const cand of candidates) {
                if (!cand || !cand.content || !Array.isArray(cand.content.parts)) continue;

                const parts = cand.content.parts;
                
                for (const part of parts) {
                  if (part && typeof part.text === "string" && part.text.length > 0) {
                    fullText += part.text;
                    safeSend(clientWs, { type: "assistant_delta", delta: part.text });
                  }
                }
              }
            }
            
            // Confirmar respuesta final
            await commitAssistantFinal(fullText, { supervise: false });
            console.log(`[DEBUG] Respuesta automática de agendamiento completada.`);
          } catch (error) {
            console.error("[RESUME ERROR] Error generando respuesta automática:", error);
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
          if (msg.item?.content?.[0]?.type === "input_text") {
            const originalUserText = msg.item.content[0].text;
            console.log(`[CLIENT MSG - TEXT] Recibido texto de usuario: "${originalUserText}"`);
            
            currentUserTranscript = originalUserText;
            currentUserInputSource = 'text';
            console.log('[SOURCE] La entrada del usuario es por TEXTO.');

            // Añadir a transcripción completa
            const userTurnString = `\nUSUARIO (con texto): ${originalUserText}`;
            fullConversationTranscript += userTurnString;
            
            // Persistir en Firestore inmediatamente
            if (conversationId && conversationCreated) {
              adminDb.collection("Conversations").doc(conversationId)
                .update({ BotTranscripcion: fullConversationTranscript })
                .catch(err => console.error("[DB ERROR] Al guardar texto del usuario:", err));
            }

            // Prefijo para el contexto
            const prefixedText = `(Mensaje Escrito) ${originalUserText}`;
            await getGeminiResponse(prefixedText);
          }
          break;
        }
      }
    } catch (e) {
      console.error("[WS onmessage ERROR]", e);
      safeSend(clientWs, { type: "error", message: e.message });
    }
  });

  clientWs.on("close", (code, reason) => {
    console.log(`[CLIENT DISCONNECTED] - Código: ${code}, Razón: ${String(reason)}`);
    
    if (conversationId && fullConversationTranscript.trim() !== "") {
      triggerReportWorkflow(conversationId, fullConversationTranscript, currentReportWebhook);
    } else {
      console.log("[REPORT] No se generará informe: no hubo conversación o ID.");
    }
    
    endStt("client_close");
    
    if (conversationId && activeConnections.has(conversationId)) {
      activeConnections.delete(conversationId);
      console.log(`[CONN_MAP] Conexión para ${conversationId} eliminada.`);
    }
  });

  clientWs.on("error", (err) => console.error("[CLIENT WS ERROR]", err));
});

/*──────────────── ENDPOINTS HTTP ─────────────────*/

// Webhook para booking completado de Cal.com
app.post("/webhook/booking-completed", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // Verificación HMAC-SHA256 Cal.com
    if (CALCOM_WEBHOOK_SECRET) {
      const signatureHeader = req.headers["x-cal-signature-256"];
      if (!signatureHeader) {
        console.warn("[WEBHOOK CAL.COM] Petición sin firma.");
        return res.status(400).send("Firma requerida.");
      }
      const hmac = crypto.createHmac("sha256", CALCOM_WEBHOOK_SECRET);
      hmac.update(req.body);
      const generatedSignature = hmac.digest("hex");
      const receivedSignature = signatureHeader.replace("sha256=", "");
      const a = Buffer.from(generatedSignature);
      const b = Buffer.from(receivedSignature);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) {
        console.error("[WEBHOOK CAL.COM] Firma inválida.");
        return res.status(401).send("Unauthorized");
      }
      console.log("[WEBHOOK CAL.COM] Firma verificada OK.");
    }

    // Parse
    const payload = JSON.parse(req.body.toString());
    console.log("[WEBHOOK CAL.COM] Payload:", JSON.stringify(payload, null, 2));
    if (payload.triggerEvent !== "BOOKING_CREATED") {
      return res.status(200).send("Evento no relevante, ignorado.");
    }

    // conversationId desde metadata o booking question
    const p = payload.payload || {};
    const meta = p.metadata || {};
    const responses = p.responses || {};
    let conversationId =
      meta.convoId ||
      responses?.convoId?.value ||
      (Array.isArray(responses)
        ? (responses.find(r => (r?.label || r?.name) === "convoId")?.value || null)
        : null);

    if (!conversationId) {
      console.warn("[WEBHOOK CAL.COM] No se encontró conversationId.");
      return res.status(400).send("Faltan datos (conversationId).");
    }

    // Datos compactos para persistir si hace falta
    const startISO = p.startTime || p.start?.time || null;
    const endISO = p.endTime || p.end?.time || null;
    const title = p.title || p.eventType?.title || "Tu cita";
    const invitee = (p.attendees && p.attendees[0]) || {};
    const bookingId = p.id || p.uid || p.bookingId || (p.booking && p.booking.id) || null;
    const timeZone = p.timeZone || invitee.timeZone || "Europe/Madrid";
    const videoCallUrl = p.videoCallUrl || null;

    const bookingData = {
      bookingId,
      title,
      startTime: startISO,
      endTime: endISO,
      timeZone,
      inviteeName: invitee.name || p.name || "",
      inviteeEmail: invitee.email || p.email || "",
      videoCallUrl,
      savedAt: admin.firestore.Timestamp.now()
    };

    // Si hay conexión activa, reanudar por WS
    const connection = activeConnections.get(conversationId);
    if (connection && typeof connection.resumeWithBookingData === "function") {
      console.log(`[WEBHOOK CAL.COM] Conversación ${conversationId} ACTIVA. Reanudando por WS.`);
      try {
        await connection.resumeWithBookingData(p);
        return res.status(200).send("Conversación reanudada con éxito (WS).");
      } catch (err) {
        console.error("[WEBHOOK CAL.COM] Error reanudando por WS, persistimos:", err);
      }
    } else {
      console.warn(`[WEBHOOK CAL.COM] Conversación ${conversationId} no activa. Persistimos evento para reanudación diferida.`);
    }

    // Persistir para el flujo user_action_completed (fallback antiguo)
    try {
      const latestRef = adminDb
        .collection("Conversations")
        .doc(conversationId)
        .collection("PendingBookingEvents")
        .doc("latest");

      await latestRef.set(bookingData, { merge: true });
      console.log(`[WEBHOOK CAL.COM] Booking guardado en PendingBookingEvents/latest para ${conversationId}.`);
      return res.status(200).send("Reserva persistida para reanudación diferida.");
    } catch (err) {
      console.error("[WEBHOOK CAL.COM] Error guardando PendingBookingEvents/latest:", err);
      return res.status(500).send("Error persistiendo la reserva.");
    }
  } catch (error) {
    console.error(`[WEBHOOK CAL.COM FATAL]`, error);
    return res.status(500).send("Error interno procesando el webhook.");
  }
});

// Aplicamos middleware express.json() para el resto de rutas POST
app.use(express.json());

// Endpoint para inyectar correcciones del supervisor
app.post("/inject-correction", async (req, res) => {
  console.log("[INJECT] Petición de corrección recibida.");

  const providedSecret = req.headers['x-supervisor-secret'];
  if (!SUPERVISOR_SECRET || providedSecret !== SUPERVISOR_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const { conversationId, correctionMessage } = req.body;
  if (!conversationId || !correctionMessage) {
    return res.status(400).send("Bad Request: Missing conversationId or correctionMessage.");
  }

  const connection = activeConnections.get(conversationId);
  if (!connection || !connection.applyCorrection) {
    console.warn(`[INJECT_WARN] No se encontró una conexión activa o válida para la conversationId: ${conversationId}.`);
    return res.status(404).send("Not Found: Active conversation not found.");
  }

  try {
    connection.applyCorrection(correctionMessage);
    res.status(200).send("Correction injected successfully.");
  } catch (error) {
    console.error(`[INJECT_FATAL] Error al aplicar corrección para ${conversationId}:`, error);
    res.status(500).send("Internal Server Error.");
  }
});

/*────────────────── ENDPOINTS HTTP Y ARRANQUE ──────────────────*/
app.get("/ping", (_, res) => res.send("pong"));
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () =>
  console.log(`🚀 Backend realtime escuchando en puerto ${PORT}`)
);

process.on("SIGTERM", () => {
  console.log("SIGTERM recibido. Cerrando conexiones...");
  if (app.getWss) {
    app.getWss().clients.forEach((ws) => {
      if (ws.readyState === WS_OPEN)
        ws.close(1012, "Reinicio del servidor");
    });
  }
  server.close(() => {
    console.log("Servidor HTTP cerrado.");
    process.exit(0);
  });
});
