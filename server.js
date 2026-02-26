"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "25mb" }));

/**
 * ENV VARS (Railway > Variables)
 * OPENAI_API_KEY
 * WHATSAPP_TOKEN
 * PHONE_NUMBER_ID
 * VERIFY_TOKEN
 * WHATSAPP_API_VERSION (optional, default v20.0)
 */
const {
  OPENAI_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  WHATSAPP_API_VERSION,
} = process.env;

const GRAPH_VERSION = WHATSAPP_API_VERSION || "v20.0";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * =========================
 * Anti-duplicação
 * =========================
 * WhatsApp pode reenviar o mesmo evento.
 * Vamos guardar IDs processados por alguns minutos.
 */
const processedMessageIds = new Map(); // id -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 min

function isDuplicateAndMark(messageId) {
  if (!messageId) return false;
  const now = Date.now();

  // cleanup simples
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

/**
 * =========================
 * Memória de conversa por número
 * =========================
 * Em produção ideal seria Redis/DB.
 * Mas isso já resolve 90% no Railway.
 */
const sessions = new Map(); // from -> { history: [...], lastActive: ts }
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 min
const MAX_TURNS = 12; // (user+assistant) pares

function getSession(from) {
  const now = Date.now();

  // limpa sessões antigas
  for (const [key, sess] of sessions.entries()) {
    if (now - sess.lastActive > SESSION_TTL_MS) sessions.delete(key);
  }

  if (!sessions.has(from)) {
    sessions.set(from, { history: [], lastActive: now });
  }

  const session = sessions.get(from);
  session.lastActive = now;
  return session;
}

function pushHistory(from, role, content) {
  const session = getSession(from);
  session.history.push({ role, content });

  // limita tamanho
  if (session.history.length > MAX_TURNS * 2) {
    session.history = session.history.slice(-MAX_TURNS * 2);
  }
}

/**
 * =========================
 * WhatsApp: enviar texto
 * =========================
 */
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const headers = {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  return axios.post(url, payload, { headers });
}

/**
 * =========================
 * Áudio: download
 * =========================
 */
async function downloadWhatsAppMediaToTmp(mediaId) {
  const metaInfoUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const headers = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };

  const metaResp = await axios.get(metaInfoUrl, { headers });
  const mediaUrl = metaResp?.data?.url;
  const mimeType = metaResp?.data?.mime_type || "audio/ogg";

  if (!mediaUrl) throw new Error("Media URL vazia.");

  const fileResp = await axios.get(mediaUrl, {
    headers,
    responseType: "arraybuffer",
  });

  let ext = ".ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) ext = ".mp3";
  if (mimeType.includes("wav")) ext = ".wav";
  if (mimeType.includes("mp4")) ext = ".mp4";
  if (mimeType.includes("webm")) ext = ".webm";

  const tmpPath = path.join("/tmp", `wa-audio-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(fileResp.data));
  return { tmpPath, mimeType };
}

/**
 * =========================
 * OpenAI: transcrição
 * =========================
 */
async function transcribeAudioFile(tmpPath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tmpPath),
    model: "whisper-1",
  });
  return (transcription?.text || "").trim();
}

/**
 * =========================
 * PROMPT TRÍVIA (travado)
 * =========================
 */
function buildSystemPrompt() {
  return `
Você é a TRÍVIA.
Frase institucional: "Tecnologia que responde."

Você é uma empresa de atendimento inteligente via WhatsApp.
Função: fazer o PRIMEIRO atendimento (triagem), entender o pedido e conduzir para:
- resposta objetiva de dúvidas
- coleta mínima de dados necessários
- encaminhamento para atendimento humanizado quando necessário
- registrar atendimento para relatórios (sem prometer algo que ainda não foi configurado)

Tom: humano, educado, direto, profissional. PT-BR.
Regras de ouro (obrigatórias):
1) NÃO recomece a conversa do zero. Se o usuário responder "Sim/Ok", você continua do ponto atual.
2) NÃO faça perguntas repetidas (nome/segmento/volume) se o usuário já explicou o que quer.
3) NÃO invente assunto. Se algo estiver fora do contexto, peça esclarecimento curto.
4) Faça no máximo 1 pergunta por mensagem (apenas se necessário).
5) Se o usuário pedir planos/módulos, explique de forma clara e curta e só então pergunte 1 coisa para orientar.
6) Se o usuário disser que quer triagem + encaminhar para humano + relatório, você confirma e já propõe a próxima etapa (o que você precisa saber para configurar).
`;
}

/**
 * Heurística simples: se usuário respondeu "sim/ok" e a última mensagem do bot era uma pergunta,
 * NÃO volte a cumprimentar, apenas continue.
 */
function normalizeYes(text) {
  const t = (text || "").trim().toLowerCase();
  return ["sim", "ok", "certo", "isso", "quero", "pode", "pode sim", "vamos", "ss"].includes(t);
}

async function generateTriviaReply(from, userText) {
  const system = buildSystemPrompt();
  const session = getSession(from);

  // Se o usuário respondeu "sim" e não temos histórico, cria um gancho padrão
  const safeUserText = userText && userText.trim() ? userText.trim() : "Olá";

  const messages = [
    { role: "system", content: system },
    ...session.history,
    { role: "user", content: safeUserText },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages,
  });

  const text = resp?.choices?.[0]?.message?.content?.trim();
  return text || "Entendi. Me diga em 1 frase o que você precisa e eu já te direciono.";
}

/**
 * =========================
 * Webhook verification (GET)
 * =========================
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * =========================
 * Webhook receive (POST)
 * =========================
 */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const body = req.body;
      if (!body?.entry?.length) return;

      for (const entry of body.entry) {
        for (const change of entry.changes || []) {
          const value = change.value;
          const messages = value?.messages || [];
          if (!messages.length) continue;

          for (const msg of messages) {
            const from = msg.from;
            const type = msg.type;
            const messageId = msg.id;

            // anti-duplicação
            if (isDuplicateAndMark(messageId)) {
              console.log("🔁 Duplicado ignorado:", messageId);
              continue;
            }

            console.log("📩 Recebido:", { from, type, messageId });

            let userText = "";

            if (type === "text") {
              userText = msg?.text?.body?.trim() || "";
            } else if (type === "audio") {
              const mediaId = msg?.audio?.id;

              if (!mediaId) {
                await sendWhatsAppText(
                  from,
                  "Recebi seu áudio, mas não consegui acessar o arquivo. Pode reenviar ou digitar sua mensagem?"
                );
                continue;
              }

              await sendWhatsAppText(from, "Recebi seu áudio ✅ Só um instante.");

              const { tmpPath } = await downloadWhatsAppMediaToTmp(mediaId);
              try {
                userText = await transcribeAudioFile(tmpPath);
              } finally {
                try { fs.unlinkSync(tmpPath); } catch (e) {}
              }

              if (!userText) {
                await sendWhatsAppText(
                  from,
                  "Não consegui transcrever seu áudio. Pode digitar em texto rapidinho?"
                );
                continue;
              }
            } else {
              await sendWhatsAppText(
                from,
                "Consigo atender por texto (e por áudio com transcrição). Me envie sua dúvida em texto, por favor."
              );
              continue;
            }

            // guarda histórico do usuário
            pushHistory(from, "user", userText);

            // gera resposta
            let reply;
            try {
              reply = await generateTriviaReply(from, userText);
            } catch (err) {
              const msgErr = err?.message || String(err);
              console.error("❌ Erro OpenAI:", msgErr);

              if (msgErr.includes("quota") || msgErr.includes("429")) {
                reply =
                  "No momento a IA atingiu limite de uso (plano/recarga). Assim que ativar a cobrança na OpenAI, volto a responder normalmente.";
              } else {
                reply =
                  "Tive uma instabilidade agora. Pode repetir em 1 frase o que você precisa?";
              }
            }

            // guarda histórico do assistente
            pushHistory(from, "assistant", reply);

            await sendWhatsAppText(from, reply);
          }
        }
      }
    } catch (error) {
      console.error("❌ Erro no webhook:", error?.response?.data || error?.message || error);
    }
  });
});

/**
 * Healthcheck
 */
app.get("/", (req, res) => res.status(200).send("TRÍVIA online ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Rodando na porta ${PORT}`));
