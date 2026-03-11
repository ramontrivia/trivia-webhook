// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Multi-Client via Supabase

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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/** =========================
 * Supabase / Companies
 * ========================= */
let COMPANIES_CACHE = [];

async function loadCompaniesFromSupabase() {
  try {
    const { data, error } = await supabase
      .from("empresas")
      .select("*");

    if (error) {
      console.error("❌ Erro ao carregar empresas do Supabase:", error.message);
      return [];
    }

    const companies = (data || []).map((row) => ({
      id: row.id,
      name: row.name || row.Nome || "",
      key: makeCompanyKey(row.name || row.Nome || `company_${row.id}`),
      phoneNumberId: String(
        row.phone_number_id ||
          row.phone_numberid ||
          row.phone_number ||
          row.phone_number_jd ||
          ""
      ),
      token: row.whatsapp_token || row.token || "",
      segment: row.segment || "",
    }));

    console.log(`✅ Empresas carregadas do Supabase: ${companies.length}`);
    return companies;
  } catch (err) {
    console.error("❌ Falha inesperada ao carregar empresas:", err.message);
    return [];
  }
}

function makeCompanyKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function refreshCompaniesCache() {
  COMPANIES_CACHE = await loadCompaniesFromSupabase();
}

function getCompanyByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return (
    COMPANIES_CACHE.find(
      (c) => String(c.phoneNumberId) === String(phoneNumberId)
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
  // TRIVIA principal
  if (clientKey === "trivia_tecnologia" || clientKey === "trivia") {
    return [
      path.join(process.cwd(), "knowledge"),
      path.join(process.cwd(), "knowledge", "trivia"),
    ];
  }

  // cliente_buscai legado
  if (clientKey === "cliente_buscai" || clientKey === "busca_ai") {
    return [path.join(process.cwd(), "knowledge", "cliente_buscai")];
  }

  // fallback genérico por key
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
      `ℹ️ [${clientKey}] Nenhum .txt encontrado nas pastas configuradas. Seguindo sem base.`
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
function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function assertEnv() {
  const missing = [];

  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!COMMERCIAL_PHONE) missing.push("COMMERCIAL_PHONE");

  if (missing.length) {
    console.error("❌ Variáveis ausentes:", missing.join(", "));
  } else {
    console.log("✅ ENV OK");
  }

  console.log("PORT:", PORT);
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log("SUPABASE_KEY:", mask(SUPABASE_KEY));
  console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE);
  console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", OPENAI_MODEL);
}
assertEnv();

/** =========================
 * In-memory state (separado por cliente)
 * ========================= */
const sessions = new Map();
/**
 * key = `${clientKey}:${userId}`
 */
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
function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

function getClientConfig(clientKey) {
  const company = getCompanyByKey(clientKey);

  if (!company) {
    console.log(`❌ Empresa não encontrada no cache para clientKey=${clientKey}`);
    return null;
  }

  if (!company.phoneNumberId || !company.token) {
    console.log(
      `❌ Config incompleta para clientKey=${clientKey}. phoneNumberId/token ausentes.`
    );
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

  try {
    const res = await axios.post(graphMessagesUrl(cfg.phoneNumberId), payload, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(
      `❌ [${clientKey}] WhatsApp send error ${status}:`,
      JSON.stringify(data || err.message)
    );
    throw err;
  }
}

function isCommercialNumber(from) {
  return COMMERCIAL_PHONE && normalizePhone(from) === COMMERCIAL_PHONE;
}

/** =========================
 * Intent / routing (regras)
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
 * Lead extraction (heurístico)
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
      `❌ [${clientKey}] Falha ao enviar lead ao comercial. Provável janela 24h fechada ou número não opt-in.`
    );
  }
}

/** =========================
 * OpenAI (MEL)
 * ========================= */
async function generateAssistantReply(clientKey, session, userText) {
  const KNOWLEDGE_BASE = getKnowledge(clientKey);

  const system = `
Você é a MEL, atendente oficial da TRÍVIA no WhatsApp.

PERSONA (essência):
- Humana, calorosa, inteligente e estratégica.
- Humor sutil (leve, elegante) quando combinar.
- Você não é “robô” e não fala como robô.
- Seu trabalho é fazer o cliente falar, entender o negócio, identificar a dor e mostrar uma mini-simulação real.

REGRAS:
- Mensagens curtas em blocos (WhatsApp).
- No máximo 1 pergunta por mensagem.
- Nunca repetir pergunta em loop.
- Nunca inventar telefone, email, valores ou planos específicos.
- Nunca falar de código, servidor, token, API.
- Só passar “contato do comercial” quando o cliente pedir (preço/planos/contratar/telefone/comercial) ou estiver muito claro que quer fechar.
- Antes de oferecer comercial, priorize 1 mini-simulação aplicada ao segmento.

ESTILO:
- Natural brasileiro.
- Pode usar 0-1 emoji por mensagem (bem dosado).
- Sempre conduzir para um próximo passo.

BASE DE CONHECIMENTO (arquivos TXT):
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

    const out = res.data?.choices?.[0]?.message?.content?.trim();
    return (
      out ||
      "Entendi 🙂 Me conta só uma coisa: seu WhatsApp hoje tá mais tranquilo ou tá uma correria?"
    );
  } catch (err) {
    console.error(
      "❌ OpenAI error:",
      err?.response?.status,
      err?.response?.data || err.message
    );
    return "Entendi 🙂 Me diz rapidinho: você quer mais agendamento, pedidos/orçamentos ou organizar o atendimento no WhatsApp?";
  }
}

/** =========================
 * Webhook routes
 * ========================= */

// Health
app.get("/", (req, res) => res.status(200).send("OK"));

// Verify webhook
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

// Receive messages
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
      console.log(
        `⚠️ Nenhuma empresa encontrada para phone_number_id=${incomingPhoneNumberId}`
      );
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
    console.log("⚠️ Nenhuma empresa carregada do Supabase.");
  }

  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
  });
}

startServer();
