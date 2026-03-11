import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}

function safeTrim(v) {
  return String(v || "").trim();
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

function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

const CLIENT_RULES = {
  trivia: {
    assistantName: "MEL",
    companyName: "TRÍVIA",
    knowledgeDir: "trivia",
    commercialPhone: COMMERCIAL_PHONE_TRIVIA,
    allowHandoff: true,
    handoffKeywords: [
      "contratar",
      "quero contratar",
      "preço",
      "preco",
      "valores",
      "plano",
      "planos",
      "assinar",
      "comercial",
      "falar com comercial",
      "quero falar com comercial",
      "quero falar com vendedor",
      "vendedor",
      "atendente humano",
      "quero comprar",
      "quero fechar",
      "vou querer",
      "quero fechar agora",
    ],
  },
  cliente_buscai: {
    assistantName: "Beatrice",
    companyName: "Busca Aí",
    knowledgeDir: "cliente_buscai",
    commercialPhone: COMMERCIAL_PHONE_BUSCAI,
    allowHandoff: false,
    handoffKeywords: [],
  },
};

let COMPANIES_CACHE = [];
const KNOWLEDGE_CACHE = new Map();
const sessions = new Map();

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

function getClientRules(clientKey) {
  const normalizedKey = normalizeCompanyKey(clientKey);
  return CLIENT_RULES[normalizedKey] || CLIENT_RULES.trivia;
}

function getLegacyCompanies() {
  const companies = [];

  if (PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
    companies.push({
      id: "legacy_trivia",
      name: "TRIVIA TECNOLOGIA",
      key: "trivia",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID),
      token: safeTrim(WHATSAPP_TOKEN),
    });
  }

  if (PHONE_NUMBER_ID_BUSCAI && WHATSAPP_TOKEN_BUSCAI) {
    companies.push({
      id: "legacy_buscai",
      name: "BUSCA AI",
      key: "cliente_buscai",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID_BUSCAI),
      token: safeTrim(WHATSAPP_TOKEN_BUSCAI),
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
          token: safeTrim(row.whatsapp_token),
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
  const normalizedKey = normalizeCompanyKey(clientKey);
  return COMPANIES_CACHE.find((c) => c.key === normalizedKey) || null;
}

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

function getKnowledgeDir(clientKey) {
  const rules = getClientRules(clientKey);
  return path.join(process.cwd(), "knowledge", rules.knowledgeDir);
}

function loadKnowledgeForClient(clientKey) {
  const normalizedKey = normalizeCompanyKey(clientKey);
  const dir = getKnowledgeDir(normalizedKey);
  const files = listTxtFilesFlat(dir).sort((a, b) => a.localeCompare(b, "pt-BR"));

  if (!files.length) {
    console.log(`[${normalizedKey}] Nenhum .txt encontrado em ${dir}`);
    return "";
  }

  const parts = [];

  for (const full of files) {
    const file = path.basename(full);
    const content = fs.readFileSync(full, "utf8");

    parts.push(
      `\n\n====================\nCLIENTE: ${normalizedKey}\nARQUIVO: ${file}\n====================\n${content}\n`
    );
  }

  console.log(`[${normalizedKey}] Knowledge carregado: ${files.length} arquivo(s)`);
  return parts.join("\n");
}

function getKnowledge(clientKey) {
  const normalizedKey = normalizeCompanyKey(clientKey);

  if (!KNOWLEDGE_CACHE.has(normalizedKey)) {
    KNOWLEDGE_CACHE.set(normalizedKey, loadKnowledgeForClient(normalizedKey));
  }

  return KNOWLEDGE_CACHE.get(normalizedKey) || "";
}

function getSession(clientKey, userId) {
  const normalizedKey = normalizeCompanyKey(clientKey);
  const k = `${normalizedKey}:${userId}`;

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

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

function isCommercialNumber(clientKey, from) {
  const rules = getClientRules(clientKey);
  const commercialPhone = normalizePhone(rules.commercialPhone || "");
  return commercialPhone && normalizePhone(from) === commercialPhone;
}

function detectIntent(clientKey, text) {
  const rules = getClientRules(clientKey);
  const t = (text || "").toLowerCase().trim();

  if (
    rules.allowHandoff &&
    rules.handoffKeywords.some((k) => t.includes(k))
  ) {
    return "handoff";
  }

  if (t.includes("agendamento")) return "agendamento";

  if (
    t.includes("pedido") ||
    t.includes("orçamento") ||
    t.includes("orcamento")
  ) {
    return "pedidos";
  }

  if (t.includes("relatório") || t.includes("relatorio")) {
    return "relatorios";
  }

  return "general";
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
  const commercialPhone = normalizePhone(rules.commercialPhone || "");

  if (!commercialPhone) {
    return "Posso te ajudar por aqui 😊";
  }

  const phonePretty = `+${commercialPhone.slice(0, 2)} (${commercialPhone.slice(
    2,
    4
  )}) ${commercialPhone.slice(4, 9)}-${commercialPhone.slice(9)}`;

  return `Fechou 😊 Aqui está o contato do nosso comercial:\n\n${phonePretty}\nhttps://wa.me/${commercialPhone}\n\nPode chamar por lá que eles te atendem agora.`;
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
  const commercialPhone = normalizePhone(rules.commercialPhone || "");

  if (!rules.allowHandoff || !commercialPhone || session.leadNotified) return;

  const report = buildLeadReport(clientKey, from, session);

  try {
    await sendWhatsAppText(clientKey, commercialPhone, report);
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
    text: { body },
  };

  const res = await axios.post(graphMessagesUrl(company.phoneNumberId), payload, {
    headers: {
      Authorization: `Bearer ${company.token}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return res.data;
}

async function generateAssistantReply(clientKey, session, userText) {
  const rules = getClientRules(clientKey);
  const KNOWLEDGE_BASE = getKnowledge(clientKey);

  const system = `
Você é ${rules.assistantName}, atendente oficial da ${rules.companyName} no WhatsApp.

REGRAS ABSOLUTAS:
1. Você atende exclusivamente a ${rules.companyName}.
2. Nunca use informações, links, contatos, regras, planos ou posicionamentos de outra marca.
3. Suas respostas devem ser baseadas prioritariamente na BASE DE CONHECIMENTO abaixo.
4. Se houver links oficiais na base, você deve enviá-los.
5. Nunca diga que não pode enviar links, se houver links na base.
6. Nunca invente links, contatos, regras ou instruções.
7. Nunca fale de código, API, token, servidor, banco de dados ou arquivos internos.
8. Nunca mencione TXT, base de conhecimento ou documentos internos.
9. Se o assunto for iPhone, iOS, Android, app, instalação ou download, responda normalmente sem acionar comercial.
10. Só fale de comercial se o cliente pedir claramente contratar, preço, valores, vendedor ou plano e isso fizer sentido para a marca atual.

ESTILO:
- Humana, simpática, clara e objetiva.
- Respostas curtas em blocos.
- No máximo 1 pergunta por mensagem.
- Linguagem natural de WhatsApp.

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
        temperature: 0.25,
        max_tokens: 320,
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
      "Entendi 😊 Me explica rapidinho o que você precisa."
    );
  } catch (err) {
    console.error("OpenAI error:", err?.response?.status, err?.response?.data || err.message);
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
      console.log("Webhook verificado");
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
      console.log(`Empresa não encontrada: ${incomingPhoneNumberId}`);
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

    const intent = detectIntent(clientKey, text);
    session.lastIntent = intent;

    if (intent === "handoff") {
      const contact = formatCommercialContact(clientKey);
      await sendWhatsAppText(clientKey, from, contact);
      pushHistory(session, "assistant", contact);

      await notifyCommercialLead(clientKey, from, session);

      const confirm =
        "Prontinho. Se você me disser o nome do negócio + cidade, eu já aviso o time com tudo mastigado pra te atender mais rápido.";
      await sendWhatsAppText(clientKey, from, confirm);
      pushHistory(session, "assistant", confirm);
      return;
    }

    const reply = await generateAssistantReply(clientKey, session, text);
    await sendWhatsAppText(clientKey, from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.status, err?.response?.data || err.message);
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
