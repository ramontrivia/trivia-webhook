import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =====================================================
ENV
===================================================== */

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GRAPH_VERSION = "v21.0";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* =====================================================
CACHE
===================================================== */

let companiesCache = [];
const sessions = new Map();
const knowledgeCache = new Map();

/* =====================================================
CARREGAR EMPRESAS
===================================================== */

async function loadCompanies() {

  const { data } = await supabase
    .from("companies")
    .select("*");

  companiesCache = data || [];

}

/* =====================================================
IDENTIFICAR CLIENTE
===================================================== */

function getCompanyByPhone(phoneNumberId) {

  return companiesCache.find(
    c => String(c.phone_number_id) === String(phoneNumberId)
  );

}

/* =====================================================
CARREGAR KNOWLEDGE
===================================================== */

function loadKnowledge(clientKey) {

  if (knowledgeCache.has(clientKey)) {
    return knowledgeCache.get(clientKey);
  }

  const dir = path.join(process.cwd(), "knowledge", clientKey);

  if (!fs.existsSync(dir)) return "";

  const files = fs.readdirSync(dir);

  const texts = files
    .filter(f => f.endsWith(".txt"))
    .map(file => fs.readFileSync(path.join(dir, file), "utf8"));

  const joined = texts.join("\n\n");

  knowledgeCache.set(clientKey, joined);

  return joined;

}

/* =====================================================
SESSION
===================================================== */

function getSession(clientKey, user) {

  const id = `${clientKey}_${user}`;

  if (!sessions.has(id)) {

    sessions.set(id, {
      history: []
    });

  }

  return sessions.get(id);

}

/* =====================================================
INTENT DETECTION
===================================================== */

async function detectIntent(message) {

  const system = `
Classifique a intenção da frase.

Responda JSON:

{
intent: "info|download|pricing|support|other"
}
`;

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ],
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  try {

    return JSON.parse(res.data.choices[0].message.content);

  } catch {

    return { intent: "info" };

  }

}

/* =====================================================
BUSCA DE CONTEXTO
===================================================== */

function retrieveContext(knowledge, message) {

  const parts = knowledge.split("\n");

  const relevant = parts
    .filter(p =>
      message
        .toLowerCase()
        .split(" ")
        .some(word => p.toLowerCase().includes(word))
    )
    .slice(0, 10);

  return relevant.join("\n");

}

/* =====================================================
GERAR RESPOSTA
===================================================== */

async function generateReply(client, session, message, context) {

  const system = `
Você é ${client.assistant_name},
atendente oficial da empresa ${client.name}.

REGRAS:

- responda de forma humana
- responda como atendente de whatsapp
- use somente as informações do CONTEXTO
- nunca invente informações
- se não tiver a resposta, diga que vai verificar
- respostas curtas
- no máximo 2 parágrafos

CONTEXTO:
${context}
`;

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        ...session.history,
        { role: "user", content: message }
      ],
      temperature: 0.3
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  return res.data.choices[0].message.content;

}

/* =====================================================
ENVIAR WHATSAPP
===================================================== */

async function sendMessage(company, to, text) {

  await axios.post(

    `https://graph.facebook.com/${GRAPH_VERSION}/${company.phone_number_id}/messages`,

    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },

    {
      headers: {
        Authorization: `Bearer ${company.whatsapp_token}`
      }
    }

  );

}

/* =====================================================
WEBHOOK
===================================================== */

app.post("/webhook", async (req, res) => {

  res.sendStatus(200);

  try {

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = message.text?.body;

    const phoneId = value.metadata.phone_number_id;

    const company = getCompanyByPhone(phoneId);

    if (!company) return;

    const clientKey = company.client_key;

    const session = getSession(clientKey, from);

    const knowledge = loadKnowledge(clientKey);

    const intent = await detectIntent(text);

    const context = retrieveContext(knowledge, text);

    const reply = await generateReply(
      company,
      session,
      text,
      context
    );

    await sendMessage(company, from, reply);

    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: reply });

  } catch (err) {

    console.error(err);

  }

});

/* =====================================================
VERIFICAÇÃO META
===================================================== */

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {

    res.status(200).send(challenge);

  } else {

    res.sendStatus(403);

  }

});

/* =====================================================
START
===================================================== */

async function start() {

  await loadCompanies();

  app.listen(PORT, () => {

    console.log("SERVER TRIVIA RUNNING");

  });

}

start();
