import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

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

const CLIENT_RULES = {
  trivia: {
    assistantName: "MEL",
    companyName: "TRÍVIA",
    knowledgeDir: path.join(process.cwd(), "knowledge", "trivia"),
    commercialPhone: COMMERCIAL_PHONE_TRIVIA,
    allowHandoff: true,
    exactDataFileHints: {
      links: ["link", "links", "download", "app", "aplicativo"],
      commercial: ["comercial", "vendedor", "planos", "plano", "preço", "preco"]
    }
  },
  cliente_buscai: {
    assistantName: "Beatrice",
    companyName: "Busca Aí",
    knowledgeDir: path.join(process.cwd(), "knowledge", "cliente_buscai"),
    commercialPhone: COMMERCIAL_PHONE_BUSCAI,
    allowHandoff: false,
    exactDataFileHints: {
      links: ["link", "links", "download", "app", "aplicativo", "ios", "iphone", "android"],
      commercial: []
    }
  }
};

let COMPANIES_CACHE = [];
const KNOWLEDGE_CACHE = new Map();
const RAW_FILE_CACHE = new Map();
const sessions = new Map();

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
  const normalizedKey = normalizeCompanyKey(clientKey);
  return CLIENT_RULES[normalizedKey] || CLIENT_RULES.trivia;
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

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

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

  if ((t.includes("iphone") || t.includes("ios")) && (t.includes("link") || t.includes("baixar") || t.includes("app"))) {
    return true;
  }

  if (t.includes("android") && (t.includes("link") || t.includes("baixar") || t.includes("app"))) {
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

  const iosUrls = urls.filter((u) => u.includes("apple.com"));
  const androidUrls = urls.filter((u) => u.includes("play.google.com"));

  const wantsIOS = t.includes("ios") || t.includes("iphone");
  const wantsAndroid = t.includes("android");
  const wantsMotorista = t.includes("motorista");
  const wantsPassageiro = t.includes("passageiro");

  if (wantsIOS && iosUrls.length) {
    return { type: "ios", urls: iosUrls };
  }

  if (wantsMotorista && androidUrls.length) {
    return { type: "motorista", urls: androidUrls };
  }

  if (wantsAndroid && androidUrls.length) {
    return { type: "android", urls: androidUrls };
  }

  if (wantsPassageiro) {
    return { type: "passageiro", urls: [...iosUrls, ...androidUrls] };
  }

  return { type: "geral", urls: [...iosUrls, ...androidUrls, ...urls] };
}

function buildBuscaAiProtectedReply(userText) {
  const result = selectBuscaAiLinksByIntent(userText);
  if (!result || !result.urls.length) return null;

  if (result.type === "ios") {
    return `Claro 😊\n\nAqui está o link oficial para iPhone/iOS:\n${result.urls[0]}`;
  }

  if (result.type === "android") {
    return `Claro 😊\n\nAqui está o link oficial para Android:\n${result.urls[0]}`;
  }

  if (result.type === "motorista") {
    return `Claro 😊\n\nAqui está o link oficial do app para motorista:\n${result.urls[0]}`;
  }

  if (result.type === "passageiro") {
    let msg = `Claro 😊\n\nAqui estão os links oficiais para passageiro:\n`;

    if (result.urls[0]) msg += `\n${result.urls[0]}`;
    if (result.urls[1] && result.urls[1] !== result.urls[0]) {
      msg += `\n\n${result.urls[1]}`;
    }

    return msg.trim();
  }

  let msg = `Claro 😊\n\nAqui estão os links oficiais do Busca Aí:\n`;
  for (const url of result.urls.slice(0, 3)) {
    msg += `\n${url}`;
  }
  return msg.trim();
}

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
  "needs_exact_data": true ou false
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
  }

  const intent = intentData.intent || "";
  const topic = (intentData.topic || "").toLowerCase();

  if (topic && base.includes(topic)) score += 4;

  if (intent === "download_app") {
    if (base.includes("link")) score += 4;
    if (base.includes("download")) score += 4;
    if (base.includes("android")) score += 3;
    if (base.includes("ios")) score += 3;
    if (base.includes("iphone")) score += 3;
    if (base.includes("play.google")) score += 3;
    if (base.includes("apple.com")) score += 3;
  }

  if (intent === "beneficios") {
    if (base.includes("vantagens")) score += 4;
    if (base.includes("benefícios")) score += 4;
    if (base.includes("beneficios")) score += 4;
    if (base.includes("passageiro")) score += 3;
    if (base.includes("motorista")) score += 3;
  }

  if (intent === "comercial") {
    if (base.includes("plano")) score += 4;
    if (base.includes("preço")) score += 4;
    if (base.includes("preco")) score += 4;
    if (base.includes("valores")) score += 4;
    if (base.includes("comercial")) score += 4;
  }

  return score;
}

function retrieveRelevantKnowledge(clientKey, intentData, userText) {
  const files = getRawFiles(clientKey);

  if (!files.length) return "";

  const ranked = files
    .map((f) => ({
      file: f.file,
      content: f.content,
      score: scoreTextForIntent(`${f.file}\n${f.content}`, intentData, userText)
    }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked.slice(0, 3);

  return selected
    .map(
      (f) =>
        `\n\n====================\nARQUIVO: ${f.file}\n====================\n${f.content}\n`
    )
    .join("\n");
}

async function generateAssistantReply(clientKey, session, userText, intentData, retrievedKnowledge) {
  const rules = getClientRules(clientKey);

  const system = `
Você é ${rules.assistantName}, atendente oficial da ${rules.companyName} no WhatsApp.

REGRAS ABSOLUTAS:
- Você atende exclusivamente a ${rules.companyName}.
- Nunca use informações, links, contatos, regras, planos ou posicionamentos de outra marca.
- Baseie sua resposta prioritariamente nos TRECHOS RECUPERADOS abaixo.
- Se os trechos não trouxerem a resposta com segurança, diga isso de forma natural e peça mais detalhes.
- Nunca invente link, telefone, preço, plano ou contato.
- Nunca fale de código, API, token, servidor, banco de dados ou arquivos internos.
- Nunca mencione TXT, base de conhecimento ou documentos internos.
- Respostas curtas em blocos.
- No máximo 1 pergunta por mensagem.
- Linguagem natural de WhatsApp.

INTENÇÃO DETECTADA:
${JSON.stringify(intentData)}

TRECHOS RECUPERADOS:
${retrievedKnowledge || "(sem trechos relevantes)"}
`.trim();

  const messages = [
    { role: "system", content: system },
    ...session.history.slice(-10).map((m) => ({
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
        temperature: 0.25,
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
      "Entendi 😊 Me explica rapidinho o que você precisa."
    );
  } catch (err) {
    console.error("OpenAI reply error:", err?.response?.status, err?.response?.data || err.message);
    return "Entendi 😊 Me explica rapidinho o que você precisa.";
  }
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
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
    const company = getCompanyByPhoneNumberId(incomingPhoneNumberId);

    if (!company) {
      console.log(`Empresa não encontrada para phone_number_id=${incomingPhoneNumberId}`);
      return;
    }

    const clientKey = company.key;

    console.log(
      `Incoming msg | client=${clientKey} | phone_number_id=${incomingPhoneNumberId} | from=${from}`
    );

    if (isCommercialNumber(clientKey, from)) return;

    const session = getSession(clientKey, from);
    pushHistory(session, "user", text);
    extractLeadFields(session, text);

    const intentData = await detectUserIntent(clientKey, session, text);

    if (intentData.intent === "comercial" && getClientRules(clientKey).allowHandoff) {
      const contact = formatCommercialContact(clientKey);
      await sendWhatsAppText(clientKey, from, contact);
      pushHistory(session, "assistant", contact);
      await notifyCommercialLead(clientKey, from, session);
      return;
    }

    if (clientKey === "cliente_buscai" && intentData.intent === "download_app") {
      const protectedReply = buildBuscaAiProtectedReply(text);

      if (protectedReply) {
        await sendWhatsAppText(clientKey, from, protectedReply);
        pushHistory(session, "assistant", protectedReply);
        return;
      }
    }

    const retrievedKnowledge = retrieveRelevantKnowledge(clientKey, intentData, text);
    const reply = await generateAssistantReply(
      clientKey,
      session,
      text,
      intentData,
      retrievedKnowledge
    );

    await sendWhatsAppText(clientKey, from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error(
      "Webhook handler error:",
      err?.response?.status,
      err?.response?.data || err.message
    );
  }
});

async function startServer() {
  assertEnv();
  await refreshCompaniesCache();

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

startServer();
