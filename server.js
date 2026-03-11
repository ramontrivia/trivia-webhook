// TRIVIA Webhook (WhatsApp Cloud API) + OpenAI + Multi-Client via Supabase

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
ENV
========================= */

const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || "");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* =========================
Supabase / Companies
========================= */

let COMPANIES_CACHE = [];

async function loadCompaniesFromSupabase() {

  const { data, error } = await supabase
    .from("Empresas")
    .select("*");

  if (error) {
    console.error("❌ Erro ao carregar empresas:", error.message);
    return [];
  }

  const companies = (data || []).map((row) => ({
    id: row.id,
    name: row.name || "",
    key: makeCompanyKey(row.name || `company_${row.id}`),
    phoneNumberId: String(row.phone_number_id || ""),
    token: row.whatsapp_token || "",
    segment: row.segment || ""
  }));

  console.log(`✅ Empresas carregadas: ${companies.length}`);

  return companies;
}

async function refreshCompaniesCache() {
  COMPANIES_CACHE = await loadCompaniesFromSupabase();
}

function getCompanyByPhoneNumberId(phoneNumberId) {
  return COMPANIES_CACHE.find(
    c => String(c.phoneNumberId) === String(phoneNumberId)
  );
}

function getCompanyByKey(key) {
  return COMPANIES_CACHE.find(c => c.key === key);
}

function detectClientByPhoneNumberId(phoneNumberId) {
  const company = getCompanyByPhoneNumberId(phoneNumberId);
  return company ? company.key : null;
}

function makeCompanyKey(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* =========================
Knowledge Base
========================= */

function listTxtFilesFlat(dir) {

  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith(".txt"))
    .map(d => path.join(dir, d.name));
}

function getKnowledgeDirs(clientKey) {

  if (clientKey === "trivia_tecnologia" || clientKey === "trivia")
    return [
      path.join(process.cwd(), "knowledge"),
      path.join(process.cwd(), "knowledge", "trivia")
    ];

  return [
    path.join(process.cwd(), "knowledge", clientKey)
  ];
}

function loadKnowledgeForClient(clientKey) {

  const dirs = getKnowledgeDirs(clientKey);
  const files = [];

  dirs.forEach(d => {
    files.push(...listTxtFilesFlat(d));
  });

  if (!files.length) {
    console.log(`ℹ️ ${clientKey} sem base de conhecimento`);
    return "";
  }

  const parts = [];

  files.forEach(f => {

    const content = fs.readFileSync(f, "utf8");

    parts.push(`
======= ${clientKey} =======
${content}
`);
  });

  return parts.join("\n");
}

const KNOWLEDGE_CACHE = new Map();

function getKnowledge(clientKey) {

  if (!KNOWLEDGE_CACHE.has(clientKey)) {
    KNOWLEDGE_CACHE.set(
      clientKey,
      loadKnowledgeForClient(clientKey)
    );
  }

  return KNOWLEDGE_CACHE.get(clientKey);
}

/* =========================
Sessions
========================= */

const sessions = new Map();

function getSession(clientKey, userId) {

  const key = `${clientKey}:${userId}`;

  if (!sessions.has(key)) {

    sessions.set(key, {
      history: [],
      lead: {}
    });

  }

  return sessions.get(key);
}

function pushHistory(session, role, text) {

  session.history.push({
    role,
    text,
    ts: new Date().toISOString()
  });

  if (session.history.length > 40)
    session.history.shift();
}

/* =========================
WhatsApp
========================= */

function normalizePhone(raw) {

  if (!raw) return "";

  return String(raw).replace(/[^\d]/g, "");
}

function graphMessagesUrl(phoneNumberId) {

  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

}

function getClientConfig(clientKey) {

  const company = getCompanyByKey(clientKey);

  if (!company) return null;

  return company;
}

async function sendWhatsAppText(clientKey, to, body) {

  const cfg = getClientConfig(clientKey);

  if (!cfg) throw new Error("Empresa não encontrada");

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  await axios.post(
    graphMessagesUrl(cfg.phoneNumberId),
    payload,
    {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* =========================
OpenAI
========================= */

async function generateAssistantReply(clientKey, session, userText) {

  const knowledge = getKnowledge(clientKey);

  const system = `
Você é MEL, atendente da TRIVIA.

Respostas curtas.
Máximo 1 pergunta por mensagem.
Tom humano.

BASE:

${knowledge}
`;

  const messages = [

    { role: "system", content: system },

    ...session.history.slice(-10).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text
    })),

    { role: "user", content: userText }

  ];

  const res = await axios.post(

    "https://api.openai.com/v1/chat/completions",

    {
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7
    },

    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }

  );

  return res.data.choices[0].message.content.trim();
}

/* =========================
Webhook
========================= */

app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN)
    return res.send(challenge);

  res.sendStatus(403);

});

app.post("/webhook", async (req, res) => {

  res.sendStatus(200);

  try {

    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body;

    const phoneId = value.metadata.phone_number_id;

    const clientKey = detectClientByPhoneNumberId(phoneId);

    if (!clientKey) {

      console.log("Empresa não encontrada:", phoneId);
      return;

    }

    console.log(`📩 ${clientKey} | ${from}`);

    const session = getSession(clientKey, from);

    pushHistory(session, "user", text);

    const reply = await generateAssistantReply(
      clientKey,
      session,
      text
    );

    await sendWhatsAppText(clientKey, from, reply);

    pushHistory(session, "assistant", reply);

  } catch (err) {

    console.error("Webhook error:", err.message);

  }

});

/* =========================
Start
========================= */

async function startServer() {

  await refreshCompaniesCache();

  if (!COMPANIES_CACHE.length)
    console.log("⚠️ Nenhuma empresa carregada");

  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando porta ${PORT}`);
  });

}

startServer();
