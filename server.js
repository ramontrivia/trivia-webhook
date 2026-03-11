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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const PHONE_NUMBER_ID_BUSCAI = process.env.PHONE_NUMBER_ID_BUSCAI;
const WHATSAPP_TOKEN_BUSCAI = process.env.WHATSAPP_TOKEN_BUSCAI;

const COMMERCIAL_PHONE_TRIVIA = normalizePhone(
  process.env.COMMERCIAL_PHONE || ""
);

const COMMERCIAL_PHONE_BUSCAI = normalizePhone(
  process.env.COMMERCIAL_PHONE_BUSCAI || ""
);

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

/* =========================================================
   CLIENT RULES
========================================================= */
const CLIENT_RULES = {
  trivia: {
    assistantName: "MEL",
    companyName: "TRÍVIA",
    knowledgeDir: path.join(process.cwd(), "knowledge", "trivia"),
    commercialPhone: COMMERCIAL_PHONE_TRIVIA,
    allowHandoff: true
  },
  cliente_buscai: {
    assistantName: "Beatrice",
    companyName: "Busca Aí",
    knowledgeDir: path.join(process.cwd(), "knowledge", "cliente_buscai"),
    commercialPhone: COMMERCIAL_PHONE_BUSCAI,
    allowHandoff: false
  }
};

/* =========================================================
   CACHE / STATE
========================================================= */
let COMPANIES_CACHE = [];
const KNOWLEDGE_CACHE = new Map();
const RAW_FILE_CACHE = new Map();
const sessions = new Map();

/* =========================================================
   UTILS
========================================================= */
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

function normalizeCompanyKey(key) {
  const k = safeTrim(key);
  if (k === "trivia_tecnologia") return "trivia";
  if (k === "busca_ai") return "cliente_buscai";
  return k;
}

function getClientRules(clientKey) {
  const normalized = normalizeCompanyKey(clientKey);
  return CLIENT_RULES[normalized] || CLIENT_RULES.trivia;
}

function assertEnv() {
  const missing = [];

  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (!PHONE_NUMBER_ID && !(SUPABASE_URL && SUPABASE_KEY)) {
    missing.push("PHONE_NUMBER_ID ou SUPABASE");
  }

  if (!WHATSAPP_TOKEN && !(SUPABASE_URL && SUPABASE_KEY)) {
    missing.push("WHATSAPP_TOKEN ou SUPABASE");
  }

  if (missing.length) {
    console.error("Variáveis ausentes:", missing.join(", "));
  } else {
    console.log("ENV OK");
  }

  console.log("PORT:", PORT);
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
  console.log("SUPABASE_URL:", SUPABASE_URL || "(não configurado)");
  console.log("SUPABASE_KEY:", mask(SUPABASE_KEY));
  console.log("PHONE_NUMBER_ID:", mask(PHONE_NUMBER_ID));
  console.log("PHONE_NUMBER_ID_BUSCAI:", mask(PHONE_NUMBER_ID_BUSCAI));
  console.log("COMMERCIAL_PHONE_TRIVIA:", COMMERCIAL_PHONE_TRIVIA || "(vazio)");
  console.log("COMMERCIAL_PHONE_BUSCAI:", COMMERCIAL_PHONE_BUSCAI || "(vazio)");
  console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", OPENAI_MODEL);
}

/* =========================================================
   COMPANIES / SUPABASE
========================================================= */
function getLegacyCompanies() {
  const companies = [];

  if (PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
    companies.push({
      id: "legacy_trivia",
      name: "TRIVIA TECNOLOGIA",
      key: "trivia",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID),
      token: safeTrim(WHATSAPP_TOKEN)
    });
  }

  if (PHONE_NUMBER_ID_BUSCAI && WHATSAPP_TOKEN_BUSCAI) {
    companies.push({
      id: "legacy_buscai",
      name: "BUSCA AI",
      key: "cliente_buscai",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID_BUSCAI),
      token: safeTrim(WHATSAPP_TOKEN_BUSCAI)
    });
  }

  return companies;
}

async function loadCompaniesFromSupabase() {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase.from("companies").select("*");

    if (error) {
      console.error("Erro ao carregar companies:", error.message);
      return [];
    }

    const mapped = (data || [])
      .map((row) => {
        const rawKey = makeCompanyKey(safeTrim(row.name) || `company_${row.id}`);
        const fixedKey = normalizeCompanyKey(rawKey);

        return {
          id: row.id,
          name: safeTrim(row.name),
          key: fixedKey,
          phoneNumberId: safeTrim(row.phone_number_id),
          token: safeTrim(row.whatsapp_token)
        };
      })
      .filter((c) => c.phoneNumberId && c.token);

    console.log(`Empresas carregadas do Supabase: ${mapped.length}`);
    return mapped;
  } catch (err) {
    console.error("Falha inesperada ao carregar companies:", err.message);
    return [];
  }
}

async function refreshCompaniesCache() {
  const dbCompanies = await loadCompaniesFromSupabase();

  if (dbCompanies.length > 0) {
    COMPANIES_CACHE = dbCompanies;
    console.log(`Cache carregado pelo Supabase: ${COMPANIES_CACHE.length}`);
    return;
  }

  COMPANIES_CACHE = getLegacyCompanies();
  console.log(`Usando fallback legado: ${COMPANIES_CACHE.length}`);
}

function getCompanyByPhoneNumberId(phoneNumberId) {
  const normalized = safeTrim(phoneNumberId);
  return (
    COMPANIES_CACHE.find((c) => safeTrim(c.phoneNumberId) === normalized) || null
  );
}

function getCompanyByKey(clientKey) {
  const normalized = normalizeCompanyKey(clientKey);
  return COMPANIES_CACHE.find((c) => c.key === normalized) || null;
}

/* =========================================================
   KNOWLEDGE
========================================================= */
function listTxtFilesFlat(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
      .map((d) => path.join(dir, d.name))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  } catch {
    return [];
  }
}

function loadKnowledgeForClient(clientKey) {
  const rules = getClientRules(clientKey);
  const files = listTxtFilesFlat(rules.knowledgeDir);

  if (!files.length) {
    console.log(`[${clientKey}] Nenhum .txt encontrado em ${rules.knowledgeDir}`);
    RAW_FILE_CACHE.set(clientKey, []);
    return "";
  }

  const parts = [];
  const rawFiles = [];

  for (const full of files) {
    const file = path.basename(full);
    const content = fs.readFileSync(full, "utf8");

    rawFiles.push({ file, content });

    parts.push(
      `\n\n====================\nCLIENTE: ${clientKey}\nARQUIVO: ${file}\n====================\n${content}\n`
    );
  }

  RAW_FILE_CACHE.set(clientKey, rawFiles);
  console.log(`[${clientKey}] Knowledge carregado: ${files.length} arquivo(s)`);
  return parts.join("\n");
}

function getKnowledge(clientKey) {
  const normalized = normalizeCompanyKey(clientKey);

  if (!KNOWLEDGE_CACHE.has(normalized)) {
    KNOWLEDGE_CACHE.set(normalized, loadKnowledgeForClient(normalized));
  }

  return KNOWLEDGE_CACHE.get(normalized) || "";
}

function getRawFiles(clientKey) {
  const normalized = normalizeCompanyKey(clientKey);

  if (!RAW_FILE_CACHE.has(normalized)) {
    loadKnowledgeForClient(normalized);
  }

  return RAW_FILE_CACHE.get(normalized) || [];
}

/* =========================================================
   SESSION
========================================================= */
function getSession(clientKey, userId) {
  const normalized = normalizeCompanyKey(clientKey);
  const id = `${normalized}:${userId}`;

  if (!sessions.has(id)) {
    sessions.set(id, {
      history: [],
      lead: { name: "", company: "", city: "", state: "", segment: "" },
      leadNotified: false
    });
  }

  return sessions.get(id);
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, ts: new Date().toISOString() });
  if (session.history.length > 40) session.history.shift();
}

/* =========================================================
   LEAD / COMMERCIAL
========================================================= */
function isCommercialNumber(clientKey, from) {
  const rules = getClientRules(clientKey);
  const commercialPhone = normalizePhone(rules.commercialPhone || "");
  return commercialPhone && normalizePhone(from) === commercialPhone;
}

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

  if (!session.lead.company && t.includes(",")) {
    const first = t.split(",")[0].trim();
    if (first.length >= 3 && first.length <= 60) {
      session.lead.company = first;
    }
  }
}

function formatCommercialContact(clientKey) {
  const rules = getClientRules(clientKey);
  const phone = normalizePhone(rules.commercialPhone || "");

  if (!phone) {
    return "Posso te ajudar por aqui 😊";
  }

  const pretty = `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 9)}-${phone.slice(9)}`;

  return `Fechou 😊 Aqui está o contato do nosso comercial:\n\n${pretty}\nhttps://wa.me/${phone}\n\nPode chamar por lá que eles te atendem agora.`;
}

function buildLeadReport(clientKey, userId, session) {
  const rules = getClientRules(clientKey);
  const { name, company, city, state, segment } = session.lead;

  const lastMsgs = session.history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Cliente" : rules.assistantName}: ${m.text}`)
    .join("\n");

  const now = new Date().toLocaleString("pt-BR");

  return (
    `Novo lead (${rules.companyName})\n` +
    `${now}\n` +
    `WhatsApp: ${userId}\n` +
    `Nome: ${name || "(não informado)"}\n` +
    `Negócio: ${company || "(não informado)"}\n` +
    `Cidade/UF: ${city || "(não informado)"}${state ? "/" + state : ""}\n` +
    `Segmento: ${segment || "(não identificado)"}\n\n` +
    `Resumo:\n${lastMsgs}`
  );
}

async function notifyCommercialLead(clientKey, from, session) {
  const rules = getClientRules(clientKey);
  const phone = normalizePhone(rules.commercialPhone || "");

  if (!rules.allowHandoff || !phone || session.leadNotified) return;

  const report = buildLeadReport(clientKey, from, session);

  try {
    await sendWhatsAppText(clientKey, phone, report);
    session.leadNotified = true;
    console.log(`[${clientKey}] Lead enviado ao comercial.`);
  } catch (e) {
    console.error(`[${clientKey}] Falha ao enviar lead:`, e?.response?.data || e.message);
  }
}

/* =========================================================
   WHATSAPP
========================================================= */
function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function sendWhatsAppText(clientKey, to, body) {
  const company = getCompanyByKey(clientKey);

  if (!company) {
    throw new Error(`Empresa não encontrada para ${clientKey}`);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  const res = await axios.post(graphMessagesUrl(company.phoneNumberId), payload, {
    headers: {
      Authorization: `Bearer ${company.token}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  return res.data;
}

/* =========================================================
   PROTECTED LINKS - BUSCA AI
========================================================= */
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s)]+/g);
  return matches || [];
}

function looksLikeDownloadIntent(text) {
  const t = (text || "").toLowerCase();

  const strongSignals = [
    "quero o link",
    "me manda o link",
    "manda o link",
    "tem o link",
    "teria o link",
    "quero baixar",
    "como baixar",
    "baixar o app",
    "baixar aplicativo",
    "download",
    "instalar o app",
    "instalar aplicativo"
  ];

  if (strongSignals.some((s) => t.includes(s))) return true;

  if (
    (t.includes("iphone") || t.includes("ios")) &&
    (t.includes("link") || t.includes("baixar") || t.includes("app"))
  ) {
    return true;
  }

  if (
    t.includes("android") &&
    (t.includes("link") || t.includes("baixar") || t.includes("app"))
  ) {
    return true;
  }

  return false;
}

function selectBuscaAiLinksByIntent(userText) {
  const t = (userText || "").toLowerCase();
  const files = getRawFiles("cliente_buscai");
  const joined = files.map((f) => `\n${f.file}\n${f.content}\n`).join("\n");
  const urls = [...new Set(extractUrls(joined))];

  if (!urls.length) return null;

  const iosPassenger = urls.find((u) => u.includes("apple.com")) || null;
  const androidPassenger =
    urls.find((u) => u.includes("play.google.com") && u.includes("client")) || null;
  const androidDriver =
    urls.find((u) => u.includes("play.google.com") && u.includes("driver")) || null;

  const wantsIOS = t.includes("ios") || t.includes("iphone");
  const wantsAndroid = t.includes("android");
  const wantsMotorista = t.includes("motorista");
  const wantsPassageiro = t.includes("passageiro");
  const isConfused =
    t.includes("qual") ||
    t.includes("qual devo") ||
    t.includes("qual é o certo") ||
    t.includes("qual e o certo") ||
    t.includes("que confusão") ||
    t.includes("que confusao") ||
    t.includes("qual baixar");

  return {
    iosPassenger,
    androidPassenger,
    androidDriver,
    wantsIOS,
    wantsAndroid,
    wantsMotorista,
    wantsPassageiro,
    isConfused
  };
}

function buildBuscaAiProtectedReply(userText) {
  const data = selectBuscaAiLinksByIntent(userText);
  if (!data) return null;

  const {
    iosPassenger,
    androidPassenger,
    androidDriver,
    wantsIOS,
    wantsAndroid,
    wantsMotorista,
    wantsPassageiro,
    isConfused
  } = data;

  if (isConfused) {
    let msg = `Claro 😊\n\nFunciona assim:\n\n`;
    msg += `• Se você é *passageiro no iPhone/iOS*, use este link:\n${iosPassenger || "(não encontrado)"}\n\n`;
    msg += `• Se você é *passageiro no Android*, use este link:\n${androidPassenger || "(não encontrado)"}\n\n`;
    msg += `• Se você é *motorista no Android*, use este link:\n${androidDriver || "(não encontrado)"}`;
    return msg.trim();
  }

  if (wantsMotorista) {
    if (androidDriver) {
      return `Claro 😊\n\nSe você é *motorista*, o link correto é este:\n${androidDriver}`;
    }
    return `Claro 😊\n\nNo momento eu não encontrei aqui o link de motorista.`;
  }

  if (wantsPassageiro && wantsIOS && iosPassenger) {
    return `Claro 😊\n\nSe você é *passageiro no iPhone/iOS*, o link correto é este:\n${iosPassenger}`;
  }

  if (wantsPassageiro && wantsAndroid && androidPassenger) {
    return `Claro 😊\n\nSe você é *passageiro no Android*, o link correto é este:\n${androidPassenger}`;
  }

  if (wantsIOS && iosPassenger) {
    return `Claro 😊\n\nPara *iPhone/iOS*, o link correto é este:\n${iosPassenger}`;
  }

  if (wantsAndroid) {
    let msg = `Claro 😊\n\nNo Android existem duas opções:\n\n`;

    if (androidPassenger) {
      msg += `• *Passageiro*:\n${androidPassenger}\n\n`;
    }

    if (androidDriver) {
      msg += `• *Motorista*:\n${androidDriver}`;
    }

    return msg.trim();
  }

  if (wantsPassageiro) {
    let msg = `Claro 😊\n\nSe você é *passageiro*, use:\n\n`;

    if (iosPassenger) {
      msg += `• *iPhone/iOS*:\n${iosPassenger}\n\n`;
    }

    if (androidPassenger) {
      msg += `• *Android*:\n${androidPassenger}`;
    }

    return msg.trim();
  }

  let msg = `Claro 😊\n\nAqui estão os links oficiais do Busca Aí:\n\n`;

  if (iosPassenger) {
    msg += `• *Passageiro iPhone/iOS*:\n${iosPassenger}\n\n`;
  }

  if (androidPassenger) {
    msg += `• *Passageiro Android*:\n${androidPassenger}\n\n`;
  }

  if (androidDriver) {
    msg += `• *Motorista Android*:\n${androidDriver}`;
  }

  return msg.trim();
}

/* =========================================================
   INTENT DETECTION
========================================================= */
async function detectUserIntent(clientKey, session, userText) {
  const rules = getClientRules(clientKey);

  const system = `
Você classifica a intenção da mensagem de um usuário no WhatsApp.

Empresa atual: ${rules.companyName}

Responda somente em JSON válido.

Formato:
{
  "intent": "beneficios|download_app|comercial|informacao|suporte|outro",
  "topic": "string curta",
  "needs_exact_data": true
}

Regras:
- "download_app" somente quando o usuário claramente quer link, baixar, download ou instalar aplicativo.
- "comercial" somente quando o usuário claramente quer preço, plano, valores, contratar ou falar com comercial.
- Perguntas sobre vantagens, benefícios, funcionamento, passageiro, motorista, segurança ou como usar NÃO são download_app.
- needs_exact_data = true somente para link oficial, telefone ou contato comercial.
`.trim();

  const messages = [
    { role: "system", content: system },
    ...session.history.slice(-6).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text
    })),
    { role: "user", content: userText }
  ];

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0,
        max_tokens: 120,
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

    const raw = res.data?.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);

    return {
      intent: parsed.intent || "outro",
      topic: parsed.topic || "",
      needs_exact_data: !!parsed.needs_exact_data
    };
  } catch (err) {
    console.error("Intent detection error:", err?.response?.data || err.message);

    if (looksLikeDownloadIntent(userText)) {
      return {
        intent: "download_app",
        topic: "app",
        needs_exact_data: true
      };
    }

    return {
      intent: "informacao",
      topic: "",
      needs_exact_data: false
    };
  }
}

/* =========================================================
   RETRIEVAL
========================================================= */
function scoreTextForIntent(text, intentData, userText) {
  const base = (text || "").toLowerCase();
  const question = (userText || "").toLowerCase();
  let score = 0;

  const tokens = question
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

  for (const token of tokens) {
    if (base.includes(token)) score += 1;
