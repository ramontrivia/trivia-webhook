"use strict";

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ================= ENV =================
const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const GRAPH_VERSION = (process.env.GRAPH_VERSION || "v19.0").trim();

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= KNOWLEDGE =================
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge", "trivia_base.txt");
let KNOWLEDGE_TEXT = "";

try {
  KNOWLEDGE_TEXT = fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
  console.log("✅ Base carregada");
} catch {
  console.log("⚠️ Base não encontrada");
}

// ================= HELPERS =================
function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isGreetingOnly(text = "") {
  const t = norm(text);
  const basics = ["oi", "ola", "bom dia", "boa tarde", "boa noite"];
  return basics.includes(t);
}

function isCommercialIntent(text = "") {
  const t = norm(text);
  const patterns = [
    "contratar",
    "quero contratar",
    "como contratar",
    "quero fechar",
    "vamos fechar",
    "falar com humano",
    "falar com atendente",
    "me passa o comercial",
    "numero do comercial",
    "whatsapp do comercial"
  ];
  return patterns.some(p => t.includes(p));
}

function detectSegment(text = "") {
  const t = norm(text);
  if (t.includes("clin")) return "clínica";
  if (t.includes("salao")) return "salão";
  if (t.includes("rest")) return "restaurante";
  if (t.includes("pizz")) return "pizzaria";
  if (t.includes("loja")) return "loja";
  return "";
}

function detectPain(text = "") {
  const t = norm(text);
  if (t.includes("caos")) return "organização";
  if (t.includes("demora")) return "tempo";
  if (t.includes("agenda")) return "agendamento";
  return "";
}

// ================= WHATS SEND =================
async function sendWhatsAppText(to, body) {
  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ================= SESSION =================
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      greeted: false,
      stage: "connection",
      segment: "",
      pain: "",
      lastReply: ""
    });
  }
  return sessions.get(id);
}

// ================= IA =================
async function askAI(session, userText) {
  const messages = [
    {
      role: "system",
      content: `
Você é Mel, da TRÍVIA.
Tom humano, elegante, direto.
No máximo 1 pergunta por mensagem.
Não repetir perguntas.
Foque em atendimento, WhatsApp e organização.
`
    },
    {
      role: "system",
      content: KNOWLEDGE_TEXT.slice(0, 8000)
    },
    { role: "user", content: userText }
  ];

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 200
  });

  return response.choices[0].message.content.trim();
}

// ================= WEBHOOK VERIFY =================
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.get("/", (_, res) => res.send("TRÍVIA online"));

// ================= WEBHOOK RECEIVE =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const from = message.from;
  const userText = message.text.body;
  const session = getSession(from);

  console.log("📩", userText);

  // ====== PRIMEIRO CONTATO ======
  if (!session.greeted) {
    session.greeted = true;
    const msg = "Oi 🙂 Mel aqui. Como você tá hoje?";
    session.lastReply = msg;
    await sendWhatsAppText(from, msg);
    return;
  }

  // ====== INTENÇÃO COMERCIAL ======
  if (isCommercialIntent(userText) && COMMERCIAL_PHONE) {
    const transferMsg =
      "Perfeito 🙂\n" +
      "Vou te colocar em contato direto com o nosso comercial.\n\n" +
      `📲 https://wa.me/${COMMERCIAL_PHONE}`;

    await sendWhatsAppText(from, transferMsg);

    // Notifica você
    await sendWhatsAppText(
      COMMERCIAL_PHONE,
      `🚀 Novo lead pediu comercial!\nNúmero: ${from}\nMensagem: ${userText}`
    );

    return;
  }

  // ====== GREETING SIMPLES ======
  if (isGreetingOnly(userText)) {
    await sendWhatsAppText(from, "Como você tá hoje?");
    return;
  }

  // ====== DETECTAR PISTAS ======
  const seg = detectSegment(userText);
  if (seg) session.segment = seg;

  const pain = detectPain(userText);
  if (pain) session.pain = pain;

  // ====== IA ======
  try {
    const reply = await askAI(session, userText);

    if (reply !== session.lastReply) {
      session.lastReply = reply;
      await sendWhatsAppText(from, reply);
    }
  } catch (err) {
    console.log(err.message);
    await sendWhatsAppText(from, "Tive um pequeno erro 😅 Me fala novamente.");
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log("✅ Servidor rodando na porta", PORT);
});
