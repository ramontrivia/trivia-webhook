// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Multi-Client
// Modo seguro: Supabase + fallback para variáveis legadas

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/** =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || "");

// legado / fallback
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const PHONE_NUMBER_ID_BUSCAI = process.env.PHONE_NUMBER_ID_BUSCAI;
const WHATSAPP_TOKEN_BUSCAI = process.env.WHATSAPP_TOKEN_BUSCAI;

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

/** =========================
 * Util
 * ========================= */
function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}

function safeTrim(v) {
  return String(v || "").trim();
}

function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function makeCompanyKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** =========================
 * Companies / Cache
 * ========================= */
let COMPANIES_CACHE = [];

function getLegacyCompanies() {
  const companies = [];

  if (PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
    companies.push({
      id: "legacy_trivia",
      name: "TRIVIA TECNOLOGIA",
      key: "trivia_tecnologia",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID),
      token: safeTrim(WHATSAPP_TOKEN),
      segment: "tecnologia",
      source: "legacy",
    });
  }

  if (PHONE_NUMBER_ID_BUSCAI && WHATSAPP_TOKEN_BUSCAI) {
    companies.push({
      id: "legacy_buscai",
      name: "BUSCA AI",
      key: "busca_ai",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID_BUSCAI),
      token: safeTrim(WHATSAPP_TOKEN_BUSCAI),
      segment: "mobilidade",
      source: "legacy",
    });
  }

  return companies;
}

async function loadCompaniesFromSupabase() {
  if (!supabase) {
    console.log("⚠️ Supabase não configurado. Usando fallback legado.");
    return [];
  }

  try {
    const { data, error } = await supabase.from("companies").select("*");

    if (error) {
      console.error("❌ Erro ao carregar companies do Supabase:", error.message);
      return [];
    }

    console.log(`📦 Linhas brutas do Supabase: ${(data || []).length}`);

    const mapped = (data || []).map((row) => ({
      id: row.id,
      name: safeTrim(row.name),
      key: makeCompanyKey(safeTrim(row.name) || `company_${row.id}`),
      phoneNumberId: safeTrim(row.phone_number_id),
      token: safeTrim(row.whatsapp_token),
      segment: safeTrim(row.segment),
      source: "supabase",
    }));

    console.log(
      "📦 Empresas mapeadas:",
      JSON.stringify(
        mapped.map((c) => ({
          id: c.id,
          name: c.name,
          key: c.key,
          phoneNumberId: c.phoneNumberId,
          tokenPresent: !!c.token,
          segment: c.segment,
          source: c.source,
        }))
      )
    );

    const validCompanies = mapped.filter((c) => c.phoneNumberId && c.token);

    console.log(`✅ Empresas válidas do Supabase: ${validCompanies.length}`);

    return validCompanies;
  } catch (err) {
    console.error("❌ Falha inesperada ao carregar companies:", err.message);
    return [];
  }
}

async function refreshCompaniesCache() {
  const dbCompanies = await loadCompaniesFromSupabase();

  if (dbCompanies.length > 0) {
    COMPANIES_CACHE = dbCompanies;
    console.log(`✅ Cache carregado pelo Supabase: ${COMPANIES_CACHE.length} empresa(s).`);
    return;
  }

  const legacy = getLegacyCompanies();
  COMPANIES_CACHE = legacy;
  console.log(`⚠️ Usando fallback legado: ${legacy.length} empresa(s).`);
}

function getCompanyByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;

  const normalized = safeTrim(phoneNumberId);

  return (
    COMPANIES_CACHE.find(
      (c) => safeTrim(c.phoneNumberId) === normalized
    ) || null
  );
}

function getCompanyByKey(companyKey) {
  return COMPANIES_CACHE.find((c) => c.key === companyKey) || null;
}

function detectClientByPhoneNumberId(phoneNumberId) {
  const company = getCompanyByPhoneNumberId(phoneNumberId);
  return company ? company.key : null;
}

/** =========================
 * Knowledge loader (por cliente)
 * ========================= */
function listTxtFilesFlat(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function getKnowledgeDirs(clientKey) {
  if (clientKey === "trivia_tecnologia" || clientKey === "trivia") {
    return [
      path.join(process.cwd(), "knowledge"),
      path.join(process.cwd(), "knowledge", "trivia"),
    ];
  }

  if (clientKey === "busca_ai" || clientKey === "cliente_buscai") {
    return [path.join(process.cwd(), "knowledge", "cliente_buscai")];
  }

  return [path.join(process.cwd(), "knowledge", clientKey)];
}

function loadKnowledgeForClient(clientKey) {
  const dirs = getKnowledgeDirs(clientKey);
  const allFiles = [];

  for (const d of dirs) {
    allFiles.push(...listTxtFilesFlat(d));
  }

  const unique = [...new Set(allFiles)].sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );

  if (!unique.length) {
    console.log(
      `ℹ️ [${clientKey}] Nenhum .txt encontrado nas pastas configuradas.`
    );
    return "";
  }

  const parts = [];
  for (const full of unique) {
    const file = path.basename(full);
    const content = fs.readFileSync(full, "utf8");
    parts.push(
      `\n\n====================\nCLIENTE: ${clientKey}\nARQUIVO: ${file}\n====================\n${content}\n`
    );
  }

  console.log(
    `✅ [${clientKey}] Knowledge carregado: ${unique.length} arquivo(s) .txt`
  );
  return parts.join("\n");
}

const KNOWLEDGE_CACHE = new Map();

function getKnowledge(clientKey) {
  if (!KNOWLEDGE_CACHE.has(clientKey)) {
    KNOWLEDGE_CACHE.set(clientKey, loadKnowledgeForClient(clientKey));
  }
  return KNOWLEDGE_CACHE.get(clientKey) || "";
}

/** =========================
 * Guards / Validations
 * ========================= */
function assertEnv() {
  const missing = [];

  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!COMMERCIAL_PHONE) missing.push("COMMERCIAL_PHONE");

  if (!PHONE_NUMBER_ID && !(SUPABASE_URL && SUPABASE_KEY)) {
    missing.push("PHONE_NUMBER_ID ou SUPABASE_URL/SUPABASE_KEY");
  }

  if (!WHATSAPP_TOKEN && !(SUPABASE_URL && SUPABASE_KEY)) {
    missing.push("WHATSAPP_TOKEN ou SUPABASE_URL/SUPABASE_KEY");
  }

  if (missing.length) {
    console.error("❌ Variáveis ausentes:", missing.join(", "));
  } else {
    console.log("✅ ENV OK");
  }

  console.log("PORT:", PORT);
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
  console.log("SUPABASE_URL:", SUPABASE_URL || "(não configurado)");
  console.log("SUPABASE_KEY:", mask(SUPABASE_KEY));
  console.log("PHONE_NUMBER_ID:", mask(PHONE_NUMBER_ID));
  console.log("PHONE_NUMBER_ID_BUSCAI:", mask(PHONE_NUMBER_ID_BUSCAI));
  console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE);
  console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", OPENAI_MODEL);
}
assertEnv();

/** =========================
 * In-memory state
 * ========================= */
const sessions = new Map();

function getSession(clientKey, userId) {
  const k = `${clientKey}:${userId}`;
  if (!sessions.has(k)) {
    sessions.set(k, {
      lead: { name: "", company: "", city: "", state: "", segment: "" },
      history: [],
      lastIntent: "",
      leadNotified: false,
    });
  }
  return sessions.get(k);
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, ts: new Date().toISOString() });
  if (session.history.length > 40) session.history.shift();
}

/** =========================
 * WhatsApp helpers
 * ========================= */
function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

function getClientConfig(clientKey) {
  const company = getCompanyByKey(clientKey);

  if (!company) {
    console.log(`❌ Empresa não encontrada no cache: ${clientKey}`);
    return null;
  }

  if (!company.phoneNumberId || !company.token) {
    console.log(
      `❌ Config incompleta para ${clientKey}. phoneNumberId/token ausentes.`
    );
    return null;
  }

  return company;
}

async function sendWhatsAppText(clientKey, to, body) {
  const cfg = getClientConfig(clientKey);

  if (!cfg) {
    throw new Error(`Configuração não encontrada para clientKey=${clientKey}`);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const res = await axios.post(graphMessagesUrl(cfg.phoneNumberId), payload, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return res.data;
}

function isCommercialNumber(from) {
  return COMMERCIAL_PHONE && normalizePhone(from) === COMMERCIAL_PHONE;
}

/** =========================
 * Intent / routing
 * ========================= */
const TRIGGER_HOT = [
  "contratar",
  "quero contratar",
  "preço",
  "preco",
  "valores",
  "plano",
  "planos",
  "assinar",
  "comercial",
  "telefone",
  "falar com comercial",
  "vendedor",
  "atendente humano",
  "quero comprar",
  "quero fechar",
  "vou querer",
  "quero fechar agora",
];

function detectIntent(text) {
  const t = (text || "").toLowerCase();

  if (TRIGGER_HOT.some((k) => t.includes(k))) return "handoff";
  if (t.includes("agendamento")) return "agendamento";
  if (
    t.includes("pedido") ||
    t.includes("orçamento") ||
    t.includes("orcamento")
  )
    return "pedidos";
  if (t.includes("relatório") || t.includes("relatorio")) return "relatorios";

  return "general";
}

/** =========================
 * Lead extraction
 * ========================= */
function extractLeadFields(session, userText) {
  const t = userText.trim();

  const ufMatch = t.match(/\b([A-Z]{2})\b/);
  const maybeUF = ufMatch?.[1] || "";

  const cityUf = t.match(/([A-Za-zÀ-ÿ\s]+)\s+([A-Z]{2})\b/);
  if (cityUf) {
    if (!session.lead.city) session.lead.city = cityUf[1].trim();
    if (!session.lead.state) session.lead.state = cityUf[2].trim();
  } else if (maybeUF && !session.lead.state) {
    session.lead.state = maybeUF;
  }

  const low = t.toLowerCase();
  const seg =
    low.includes("salão") || low.includes("salao")
      ? "Salão/Beleza"
      : low.includes("barbearia")
      ? "Barbearia"
      : low.includes("clínica") || low.includes("clinica")
      ? "Clínica"
      : low.includes("restaurante") || low.includes("lanchonete")
      ? "Alimentação"
      : low.includes("oficina")
      ? "Oficina"
      : session.lead.segment;

  session.lead.segment = seg;

  if (!session.lead.company && t.includes(",")) {
    const first = t.split(",")[0].trim();
    if (first.length >= 3 && first.length <= 60) session.lead.company = first;
  }
}

function formatCommercialContact() {
  const phonePretty = COMMERCIAL_PHONE
    ? `+${COMMERCIAL_PHONE.slice(0, 2)} (${COMMERCIAL_PHONE.slice(
        2,
        4
      )}) ${COMMERCIAL_PHONE.slice(4, 9)}-${COMMERCIAL_PHONE.slice(9)}`
    : "";

  return `Fechou 😊 Aqui está o contato do nosso comercial:\n\n${phonePretty}\nhttps://wa.me/${COMMERCIAL_PHONE}\n\nPode chamar por lá que eles te atendem agora.`;
}

function buildLeadReport(clientKey, userId, session) {
  const { name, company, city, state, segment } = session.lead;

  const lastMsgs = session.history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Cliente" : "MEL"}: ${m.text}`)
    .join("\n");

  const now = new Date().toLocaleString("pt-BR");

  return (
    `📌 *Novo lead (${clientKey})*\n` +
    `🕒 ${now}\n` +
    `👤 WhatsApp (ID): ${userId}\n` +
    `🙋 Nome: ${name || "(não informado)"}\n` +
    `🏢 Negócio: ${company || "(não informado)"}\n` +
    `📍 Cidade/UF: ${city || "(não informado)"}${state ? "/" + state : ""}\n` +
    `🏷️ Segmento: ${segment || "(não identificado)"}\n\n` +
    `🗒️ *Resumo (últimas mensagens)*\n` +
    `${lastMsgs}`
  );
}

async function notifyCommercialLead(clientKey, from, session) {
  if (session.leadNotified) return;

  const report = buildLeadReport(clientKey, from, session);

  try {
    await sendWhatsAppText(clientKey, COMMERCIAL_PHONE, report);
    session.leadNotified = true;
    console.log(`✅ [${clientKey}] Lead enviado ao comercial.`);
  } catch (e) {
    console.error(
      `❌ [${clientKey}] Falha ao enviar lead ao comercial:`,
      e?.response?.data || e.message
    );
  }
}

/** =========================
 * OpenAI
 * ========================= */
async function generateAssistantReply(clientKey, session, userText) {
  const KNOWLEDGE_BASE = getKnowledge(clientKey);

  const system = `
Você é a MEL, atendente oficial da TRÍVIA no WhatsApp.

REGRAS:
- Respostas curtas em blocos.
- No máximo 1 pergunta por mensagem.
- Não invente preços, planos, emails ou telefones.
- Nunca fale de código, API, token ou servidor.
- Seja humana, natural e objetiva.

BASE DE CONHECIMENTO:
${KNOWLEDGE_BASE ? KNOWLEDGE_BASE.slice(0, 12000) : "(sem base)"}
  `.trim();

  const messages = [
    { role: "system", content: system },
    ...session.history.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    })),
    { role: "user", content: userText },
  ];

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 260,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 25000,
      }
    );

    return (
      res.data?.choices?.[0]?.message?.content?.trim() ||
      "Entendi 🙂 Me conta só uma coisa: você quer saber mais sobre como funciona?"
    );
  } catch (err) {
    console.error(
      "❌ OpenAI error:",
      err?.response?.status,
      err?.response?.data || err.message
    );
    return "Entendi 🙂 Me diz rapidinho como posso te ajudar melhor.";
  }
}

/** =========================
 * Webhook routes
 * ========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verificado");
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg?.text?.body || "";
    if (!from || !text) return;

    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    const clientKey = detectClientByPhoneNumberId(incomingPhoneNumberId);

    if (!clientKey) {
      console.log(`⚠️ empresa não encontrada: ${incomingPhoneNumberId}`);
      return;
    }

    console.log(
      `📩 Incoming msg | client=${clientKey} | phone_number_id=${incomingPhoneNumberId} | from=${from}`
    );

    if (isCommercialNumber(from)) return;

    const session = getSession(clientKey, from);
    pushHistory(session, "user", text);

    extractLeadFields(session, text);

    const intent = detectIntent(text);
    session.lastIntent = intent;

    if (intent === "handoff") {
      const contact = formatCommercialContact();
      await sendWhatsAppText(clientKey, from, contact);
      pushHistory(session, "assistant", contact);

      await notifyCommercialLead(clientKey, from, session);

      const confirm =
        "Prontinho ✅ Se você me disser o *nome do negócio + cidade*, eu já aviso o time com tudo mastigado pra te atender mais rápido 😉";
      await sendWhatsAppText(clientKey, from, confirm);
      pushHistory(session, "assistant", confirm);

      return;
    }

    const reply = await generateAssistantReply(clientKey, session, text);
    await sendWhatsAppText(clientKey, from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error(
      "❌ Webhook handler error:",
      err?.response?.status,
      err?.response?.data || err.message
    );
  }
});

/** =========================
 * Start
 * ========================= */
async function startServer() {
  await refreshCompaniesCache();

  if (!COMPANIES_CACHE.length) {
    console.log("⚠️ Nenhuma empresa carregada no cache.");
  }

  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
  });
}

startServer();
