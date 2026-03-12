import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================================================
   ENV
========================================================= */
const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

/* =========================================================
   CACHE / STATE
========================================================= */
let companiesCache = [];
const sessions = new Map();
const knowledgeCache = new Map();

/* =========================================================
   UTILS
========================================================= */
function safeTrim(v) {
  return String(v || "").trim();
}

function normalizeText(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

function assertEnv() {
  const missing = [];

  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length) {
    console.error("Variáveis ausentes:", missing.join(", "));
  } else {
    console.log("ENV OK");
  }
}

/* =========================================================
   COMPANIES
========================================================= */
async function loadCompanies() {
  if (!supabase) {
    console.error("Supabase não configurado.");
    companiesCache = [];
    return;
  }

  try {
    const { data, error } = await supabase.from("companies").select("*");

    if (error) {
      console.error("Erro ao carregar companies:", error.message);
      companiesCache = [];
      return;
    }

    companiesCache = (data || []).filter(
      (c) =>
        safeTrim(c.client_key) &&
        safeTrim(c.phone_number_id) &&
        safeTrim(c.whatsapp_token)
    );

    console.log(`Companies carregadas: ${companiesCache.length}`);
  } catch (err) {
    console.error("Falha ao carregar companies:", err.message);
    companiesCache = [];
  }
}

function getCompanyByPhone(phoneNumberId) {
  return companiesCache.find(
    (c) => String(c.phone_number_id) === String(phoneNumberId)
  );
}

/* =========================================================
   KNOWLEDGE
========================================================= */
function splitTextIntoBlocks(text, blockSize = 900, overlap = 180) {
  const clean = String(text || "").replace(/\r/g, "").trim();
  if (!clean) return [];

  if (clean.length <= blockSize) return [clean];

  const blocks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + blockSize, clean.length);

    if (end < clean.length) {
      const lastBreak = Math.max(
        clean.lastIndexOf("\n\n", end),
        clean.lastIndexOf(". ", end),
        clean.lastIndexOf("\n", end)
      );

      if (lastBreak > start + 250) {
        end = lastBreak;
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) blocks.push(chunk);

    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return blocks;
}

function loadKnowledge(clientKey) {
  if (knowledgeCache.has(clientKey)) {
    return knowledgeCache.get(clientKey);
  }

  const dir = path.join(process.cwd(), "knowledge", clientKey);

  if (!fs.existsSync(dir)) {
    const empty = { fullText: "", documents: [], blocks: [] };
    knowledgeCache.set(clientKey, empty);
    console.log(`[${clientKey}] pasta knowledge não encontrada.`);
    return empty;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const documents = files.map((file) => {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    return { file, content };
  });

  const blocks = [];

  for (const doc of documents) {
    const pieces = splitTextIntoBlocks(doc.content);

    pieces.forEach((piece, index) => {
      blocks.push({
        file: doc.file,
        index,
        content: piece,
        normalized: normalizeText(`${doc.file}\n${piece}`)
      });
    });
  }

  const fullText = documents
    .map((d) => `ARQUIVO: ${d.file}\n${d.content}`)
    .join("\n\n");

  const knowledge = { fullText, documents, blocks };
  knowledgeCache.set(clientKey, knowledge);

  console.log(
    `[${clientKey}] knowledge carregado: ${documents.length} arquivo(s), ${blocks.length} bloco(s)`
  );

  return knowledge;
}

/* =========================================================
   SESSION
========================================================= */
function getSession(clientKey, user) {
  const id = `${clientKey}_${user}`;

  if (!sessions.has(id)) {
    sessions.set(id, {
      history: []
    });
  }

  return sessions.get(id);
}

function pushHistory(session, role, content) {
  session.history.push({ role, content });

  if (session.history.length > 16) {
    session.history = session.history.slice(-16);
  }
}

/* =========================================================
   DB LOGS / CONVERSATIONS
========================================================= */
async function insertMessageLog({
  company,
  clientKey,
  userPhone,
  direction,
  message,
  intent
}) {
  if (!supabase) return;

  try {
    const payload = {
      company_id: company.id ?? null,
      client_key: clientKey,
      company_name: company.name || "",
      user_phone: userPhone,
      direction,
      message,
      intent: intent || null
    };

    const { error } = await supabase.from("messages").insert(payload);

    if (error) {
      console.error("Erro ao inserir em messages:", error.message);
    }
  } catch (err) {
    console.error("Falha ao inserir em messages:", err.message);
  }
}

async function upsertConversation({
  company,
  clientKey,
  userPhone,
  lastMessage,
  lastIntent
}) {
  if (!supabase) return;

  try {
    const { data: existing, error: findError } = await supabase
      .from("conversations")
      .select("id, message_count")
      .eq("client_key", clientKey)
      .eq("user_phone", userPhone)
      .maybeSingle();

    if (findError) {
      console.error("Erro ao buscar conversation:", findError.message);
      return;
    }

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from("conversations")
        .update({
          company_id: company.id ?? null,
          client_key: clientKey,
          user_phone: userPhone,
          last_message: lastMessage,
          last_intent: lastIntent || null,
          message_count: Number(existing.message_count || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq("id", existing.id);

      if (updateError) {
        console.error("Erro ao atualizar conversations:", updateError.message);
      }
    } else {
      const { error: insertError } = await supabase
        .from("conversations")
        .insert({
          company_id: company.id ?? null,
          client_key: clientKey,
          user_phone: userPhone,
          last_message: lastMessage,
          last_intent: lastIntent || null,
          message_count: 1
        });

      if (insertError) {
        console.error("Erro ao inserir conversations:", insertError.message);
      }
    }
  } catch (err) {
    console.error("Falha em upsertConversation:", err.message);
  }
}

/* =========================================================
   INTENT DETECTION
========================================================= */
async function detectIntent(company, message) {
  const system = `
Classifique a intenção da frase de um usuário no WhatsApp.

Empresa atual: ${company.name}

Responda SOMENTE JSON válido neste formato:
{
  "intent": "info|download|pricing|support|comparison|institutional|other",
  "topic": "string curta",
  "audience": "passageiro|motorista|empresa|geral",
  "needs_exact_link": true
}

Regras:
- "download" somente para baixar, instalar, link, app, ios, android, play store, app store.
- "pricing" somente para preço, valor, plano, contratar, comercial.
- "institutional" para "o que é", "quem é", "como funciona a empresa".
- "needs_exact_link" true somente quando o usuário quer link exato.
`.trim();

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: message }
        ],
        temperature: 0,
        max_tokens: 180,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    const raw = res.data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return {
      intent: parsed.intent || "info",
      topic: parsed.topic || "",
      audience: parsed.audience || "geral",
      needs_exact_link: !!parsed.needs_exact_link
    };
  } catch (err) {
    console.error("detectIntent error:", err?.response?.data || err.message);

    const t = normalizeText(message);

    return {
      intent:
        t.includes("link") ||
        t.includes("baixar") ||
        t.includes("instalar") ||
        t.includes("download")
          ? "download"
          : t.includes("preco") ||
            t.includes("valor") ||
            t.includes("plano") ||
            t.includes("contratar")
          ? "pricing"
          : t.includes("o que e") || t.includes("quem e")
          ? "institutional"
          : "info",
      topic: "",
      audience: t.includes("motorista")
        ? "motorista"
        : t.includes("passageiro")
        ? "passageiro"
        : "geral",
      needs_exact_link:
        t.includes("link") ||
        t.includes("baixar") ||
        t.includes("download") ||
        t.includes("instalar")
    };
  }
}

/* =========================================================
   RETRIEVAL
========================================================= */
function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3);
}

function scoreBlock(block, message, intentData) {
  const msgNorm = normalizeText(message);
  const msgTokens = tokenize(message);
  const topicTokens = tokenize(intentData.topic || "");
  const base = block.normalized;

  let score = 0;

  for (const token of msgTokens) {
    if (base.includes(token)) score += 2;
  }

  for (const token of topicTokens) {
    if (base.includes(token)) score += 3;
  }

  if (intentData.intent === "download") {
    if (base.includes("link")) score += 8;
    if (base.includes("download")) score += 8;
    if (base.includes("play store")) score += 6;
    if (base.includes("app store")) score += 6;
    if (base.includes("android")) score += 5;
    if (base.includes("ios")) score += 5;
    if (base.includes("iphone")) score += 5;
    if (base.includes("apple.com")) score += 10;
    if (base.includes("play.google.com")) score += 10;
  }

  if (intentData.intent === "pricing") {
    if (base.includes("preco")) score += 8;
    if (base.includes("valor")) score += 8;
    if (base.includes("plano")) score += 8;
    if (base.includes("comercial")) score += 6;
    if (base.includes("contratar")) score += 6;
  }

  if (intentData.intent === "institutional") {
    if (base.includes("o que e")) score += 5;
    if (base.includes("quem somos")) score += 5;
    if (base.includes("empresa")) score += 4;
    if (base.includes("solucao")) score += 4;
  }

  if (intentData.audience === "passageiro") {
    if (base.includes("passageiro")) score += 8;
  }

  if (intentData.audience === "motorista") {
    if (base.includes("motorista")) score += 8;
    if (base.includes("driver")) score += 5;
  }

  if (msgNorm.includes("vantagens") || msgNorm.includes("beneficios")) {
    if (base.includes("vantagens") || base.includes("beneficios")) score += 10;
  }

  if (msgNorm.includes("como funciona")) {
    if (base.includes("como funciona")) score += 10;
    if (base.includes("funciona")) score += 4;
  }

  return score;
}

function retrieveContext(knowledge, message, intentData, topK = 4) {
  const ranked = knowledge.blocks
    .map((block) => ({
      ...block,
      score: scoreBlock(block, message, intentData)
    }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked.filter((b) => b.score > 0).slice(0, topK);

  if (!selected.length) {
    return "";
  }

  return selected
    .map(
      (b) =>
        `ARQUIVO: ${b.file}\nBLOCO: ${b.index + 1}\n${b.content}`
    )
    .join("\n\n--------------------\n\n");
}

/* =========================================================
   EXACT LINKS
========================================================= */
function extractUrls(text) {
  return [...new Set((text.match(/https?:\/\/[^\s)]+/g) || []))];
}

function findDownloadLinks(knowledge, intentData, message) {
  const urls = extractUrls(knowledge.fullText);
  if (!urls.length) return null;

  const t = normalizeText(message);

  const ios = urls.find((u) => u.includes("apple.com")) || null;
  const androidPassenger =
    urls.find(
      (u) =>
        u.includes("play.google.com") &&
        (u.toLowerCase().includes("client") ||
          u.toLowerCase().includes("passageiro"))
    ) ||
    urls.find((u) => u.includes("play.google.com") && !u.toLowerCase().includes("driver")) ||
    null;

  const androidDriver =
    urls.find(
      (u) =>
        u.includes("play.google.com") &&
        (u.toLowerCase().includes("driver") ||
          u.toLowerCase().includes("motorista"))
    ) || null;

  const wantsIOS = t.includes("ios") || t.includes("iphone");
  const wantsAndroid = t.includes("android");
  const wantsPassenger = t.includes("passageiro");
  const wantsDriver = t.includes("motorista");
  const asksWhich =
    t.includes("qual") ||
    t.includes("qual baixar") ||
    t.includes("qual e o certo") ||
    t.includes("qual é o certo");

  if (!intentData.needs_exact_link) return null;

  if (asksWhich) {
    let msg = "Claro 😊\n\nFunciona assim:\n\n";
    if (ios) msg += `• Passageiro iPhone/iOS:\n${ios}\n\n`;
    if (androidPassenger) msg += `• Passageiro Android:\n${androidPassenger}\n\n`;
    if (androidDriver) msg += `• Motorista Android:\n${androidDriver}`;
    return msg.trim();
  }

  if (wantsDriver && androidDriver) {
    return `Claro 😊\n\nSe você é motorista, o link correto é este:\n${androidDriver}`;
  }

  if (wantsPassenger && wantsIOS && ios) {
    return `Claro 😊\n\nSe você é passageiro no iPhone/iOS, o link correto é este:\n${ios}`;
  }

  if (wantsPassenger && wantsAndroid && androidPassenger) {
    return `Claro 😊\n\nSe você é passageiro no Android, o link correto é este:\n${androidPassenger}`;
  }

  if (wantsIOS && ios) {
    return `Claro 😊\n\nPara iPhone/iOS, use este link:\n${ios}`;
  }

  if (wantsAndroid) {
    let msg = "Claro 😊\n\nNo Android existem estas opções:\n\n";
    if (androidPassenger) msg += `• Passageiro:\n${androidPassenger}\n\n`;
    if (androidDriver) msg += `• Motorista:\n${androidDriver}`;
    return msg.trim();
  }

  if (wantsPassenger) {
    let msg = "Claro 😊\n\nSe você é passageiro, use:\n\n";
    if (ios) msg += `• iPhone/iOS:\n${ios}\n\n`;
    if (androidPassenger) msg += `• Android:\n${androidPassenger}`;
    return msg.trim();
  }

  let msg = "Claro 😊\n\nAqui estão os links oficiais:\n\n";
  if (ios) msg += `• iPhone/iOS:\n${ios}\n\n`;
  if (androidPassenger) msg += `• Android Passageiro:\n${androidPassenger}\n\n`;
  if (androidDriver) msg += `• Android Motorista:\n${androidDriver}`;
  return msg.trim();
}

/* =========================================================
   AI REPLY
========================================================= */
async function generateReply(client, session, message, context, intentData) {
  const system = `
Você é ${client.assistant_name}, atendente oficial da empresa ${client.name}.

REGRAS:
- responda de forma humana, natural e profissional
- responda como atendente de whatsapp
- use SOMENTE as informações do CONTEXTO
- nunca invente dados
- se o contexto não trouxer a resposta com segurança, diga isso com naturalidade
- respostas curtas, claras e úteis
- no máximo 2 parágrafos
- nunca fale de arquivos internos, txt, base de dados, prompt ou sistema
- nunca use informações de outra empresa
- não diga "vou verificar" se o CONTEXTO já tem a resposta
- se houver contexto suficiente, responda diretamente

INTENÇÃO:
${JSON.stringify(intentData)}

CONTEXTO:
${context || "(sem contexto suficiente)"}
`.trim();

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: system },
          ...session.history,
          { role: "user", content: message }
        ],
        temperature: 0.2,
        max_tokens: 260
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 25000
      }
    );

    return (
      res.data?.choices?.[0]?.message?.content?.trim() ||
      "Posso te ajudar com mais detalhes, se você me disser exatamente o que deseja saber."
    );
  } catch (err) {
    console.error("generateReply error:", err?.response?.data || err.message);
    return "Entendi. Me diga com um pouco mais de detalhe o que você precisa, que eu te ajudo.";
  }
}

/* =========================================================
   WHATSAPP
========================================================= */
async function sendMessage(company, to, text) {
  try {
    await axios.post(
      graphMessagesUrl(company.phone_number_id),
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${company.whatsapp_token}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
  } catch (err) {
    console.error(
      "sendMessage error:",
      err?.response?.status,
      err?.response?.data || err.message
    );
    throw err;
  }
}

/* =========================================================
   WEBHOOK
========================================================= */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = safeTrim(message.text?.body);
    if (!from || !text) return;

    const phoneId = value?.metadata?.phone_number_id;
    const company = getCompanyByPhone(phoneId);

    if (!company) {
      console.log(`Empresa não encontrada para phone_number_id=${phoneId}`);
      return;
    }

    const clientKey = company.client_key;
    const session = getSession(clientKey, from);
    const knowledge = loadKnowledge(clientKey);

    console.log(`Mensagem recebida | client=${clientKey} | from=${from} | text=${text}`);

    const intentData = await detectIntent(company, text);
    console.log(`[${clientKey}] intent=`, intentData);

    await insertMessageLog({
      company,
      clientKey,
      userPhone: from,
      direction: "user",
      message: text,
      intent: intentData.intent
    });

    await upsertConversation({
      company,
      clientKey,
      userPhone: from,
      lastMessage: text,
      lastIntent: intentData.intent
    });

    const exactLinkReply = findDownloadLinks(knowledge, intentData, text);
    if (exactLinkReply) {
      await sendMessage(company, from, exactLinkReply);

      await insertMessageLog({
        company,
        clientKey,
        userPhone: from,
        direction: "assistant",
        message: exactLinkReply,
        intent: intentData.intent
      });

      await upsertConversation({
        company,
        clientKey,
        userPhone: from,
        lastMessage: exactLinkReply,
        lastIntent: intentData.intent
      });

      pushHistory(session, "user", text);
      pushHistory(session, "assistant", exactLinkReply);
      return;
    }

    const context = retrieveContext(knowledge, text, intentData, 4);
    console.log(`[${clientKey}] context_length=${context.length}`);

    const reply = await generateReply(
      company,
      session,
      text,
      context,
      intentData
    );

    await sendMessage(company, from, reply);

    await insertMessageLog({
      company,
      clientKey,
      userPhone: from,
      direction: "assistant",
      message: reply,
      intent: intentData.intent
    });

    await upsertConversation({
      company,
      clientKey,
      userPhone: from,
      lastMessage: reply,
      lastIntent: intentData.intent
    });

    pushHistory(session, "user", text);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
  }
});

/* =========================================================
   START
========================================================= */
async function start() {
  assertEnv();
  await loadCompanies();

  app.listen(PORT, () => {
    console.log("SERVER TRIVIA RUNNING");
  });
}

start();
