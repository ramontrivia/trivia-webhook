// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Lead Notify
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

/** =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 8080;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || "");

/** =========================
 * Validations / Debug
 * ========================= */
function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}
function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}
function assertEnv() {
  const missing = [];
  if (!PHONE_NUMBER_ID) missing.push("PHONE_NUMBER_ID");
  if (!WHATSAPP_TOKEN) missing.push("WHATSAPP_TOKEN");
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!COMMERCIAL_PHONE) missing.push("COMMERCIAL_PHONE");

  if (missing.length) console.error("❌ Variáveis ausentes:", missing.join(", "));
  else console.log("✅ ENV OK");

  console.log("PORT:", PORT);
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
  console.log("PHONE_NUMBER_ID:", mask(PHONE_NUMBER_ID));
  console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE);
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", OPENAI_MODEL);
}
assertEnv();

/** =========================
 * Knowledge loader (ALL TXT)
 * ========================= */
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
let KNOWLEDGE_BASE = "";

function loadAllTxtKnowledge() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      console.log("ℹ️ Pasta /knowledge não existe. Seguindo sem base.");
      return "";
    }

    const files = fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

    if (!files.length) {
      console.log("ℹ️ Nenhum .txt encontrado em /knowledge.");
      return "";
    }

    const chunks = [];
    for (const f of files) {
      const full = path.join(KNOWLEDGE_DIR, f);
      const content = fs.readFileSync(full, "utf8");
      chunks.push(`\n\n================ FILE: ${f} ================\n${content}\n`);
    }

    console.log(`✅ Knowledge carregado: ${files.length} arquivos .txt`);
    console.log("📄 Arquivos:", files.join(", "));
    return chunks.join("\n");
  } catch (e) {
    console.log("⚠️ Erro ao carregar knowledge:", e?.message || e);
    return "";
  }
}

KNOWLEDGE_BASE = loadAllTxtKnowledge();

/** =========================
 * In-memory state
 * ========================= */
const sessions = new Map();
const processedMessageIds = new Set(); // idempotência simples

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      lead: { name: "", company: "", city: "", state: "", segment: "" },
      history: [],
      stage: "start",
      lastIntent: "",
      lastQuestionKey: "",
    });
  }
  return sessions.get(userId);
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, ts: new Date().toISOString() });
  if (session.history.length > 40) session.history.shift();
}

/** =========================
 * WhatsApp helpers
 * ========================= */
function graphMessagesUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppText(to, body) {
  // WhatsApp tem limite; vamos quebrar em blocos
  const parts = splitMessage(body, 3500);

  for (const part of parts) {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: part },
    };

    try {
      await axios.post(graphMessagesUrl(), payload, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      });
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.error(`❌ WhatsApp send error ${status}:`, JSON.stringify(data || err.message));
      throw err;
    }
  }
}

function splitMessage(text, maxLen = 3500) {
  const s = String(text || "");
  if (s.length <= maxLen) return [s];

  const parts = [];
  let i = 0;
  while (i < s.length) {
    parts.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

function isCommercialNumber(from) {
  return COMMERCIAL_PHONE && normalizePhone(from) === COMMERCIAL_PHONE;
}

/** =========================
 * Intent detection
 * ========================= */
const HANDOFF_KEYWORDS = [
  "contratar", "quero contratar", "quero fechar", "fechar",
  "preço", "preco", "valores", "quanto custa", "investimento",
  "plano", "planos", "assinar",
  "telefone", "numero", "contato", "whatsapp do comercial",
  "comercial", "vendedor", "humano", "atendente humano"
];

function detectIntent(text) {
  const t = (text || "").toLowerCase().trim();
  if (!t) return "general";

  if (HANDOFF_KEYWORDS.some((k) => t.includes(k))) return "handoff";

  if (t.includes("agendamento")) return "agendamento";
  if (t.includes("pedido") || t.includes("orçamento") || t.includes("orcamento")) return "pedidos";
  if (t.includes("relatório") || t.includes("relatorio")) return "relatorios";

  return "general";
}

/** =========================
 * Lead extraction (leve)
 * ========================= */
function extractLeadFields(session, userText) {
  const t = (userText || "").trim();

  // Nome: "meu nome é X"
  const nameMatch = t.match(/meu nome (é|eh)\s+([A-Za-zÀ-ÿ\s]{2,40})/i);
  if (nameMatch && !session.lead.name) session.lead.name = nameMatch[2].trim();

  // UF
  const ufMatch = t.match(/\b([A-Z]{2})\b/);
  const maybeUF = ufMatch?.[1] || "";

  // Cidade + UF (ex: "Mateus Leme MG")
  const cityUf = t.match(/([A-Za-zÀ-ÿ\s]+)\s+([A-Z]{2})\b/);
  if (cityUf && !session.lead.state) {
    session.lead.city = session.lead.city || cityUf[1].trim();
    session.lead.state = session.lead.state || cityUf[2].trim();
  } else if (maybeUF && !session.lead.state) {
    session.lead.state = maybeUF;
  }

  // Segmento por palavras
  const low = t.toLowerCase();
  if (!session.lead.segment) {
    if (low.includes("salão") || low.includes("salao")) session.lead.segment = "Salão/Beleza";
    else if (low.includes("barbearia")) session.lead.segment = "Barbearia";
    else if (low.includes("clínica") || low.includes("clinica")) session.lead.segment = "Clínica";
    else if (low.includes("loja")) session.lead.segment = "Loja";
    else if (low.includes("restaurante") || low.includes("lanchonete")) session.lead.segment = "Alimentação";
  }

  // Empresa: pega antes da vírgula quando faz sentido
  if (!session.lead.company && t.includes(",")) {
    const first = t.split(",")[0].trim();
    if (first.length >= 3 && first.length <= 60) session.lead.company = first;
  }
}

function formatCommercialContact() {
  const phonePretty = COMMERCIAL_PHONE
    ? `+${COMMERCIAL_PHONE.slice(0, 2)} (${COMMERCIAL_PHONE.slice(2, 4)}) ${COMMERCIAL_PHONE.slice(
        4,
        9
      )}-${COMMERCIAL_PHONE.slice(9)}`
    : "";

  return (
    `Fechou 😊 Aqui está o contato do nosso comercial:\n\n` +
    `${phonePretty}\nhttps://wa.me/${COMMERCIAL_PHONE}\n\n` +
    `Se quiser, me diga *só o nome do negócio + cidade* que eu já aviso eles com tudo mastigado.`
  );
}

function buildLeadReport(userId, session) {
  const { name, company, city, state, segment } = session.lead;
  const lastMsgs = session.history
    .slice(-14)
    .map((m) => `${m.role === "user" ? "Cliente" : "TRÍVIA"}: ${m.text}`)
    .join("\n");

  const now = new Date().toLocaleString("pt-BR");

  return (
    `📌 *LEAD QUENTE — pediu comercial*\n` +
    `🕒 ${now}\n` +
    `👤 WhatsApp (ID): ${userId}\n` +
    `🙋 Nome: ${name || "(não informado)"}\n` +
    `🏢 Empresa: ${company || "(não informado)"}\n` +
    `📍 Cidade/UF: ${city || "(não informado)"}${state ? "/" + state : ""}\n` +
    `🏷️ Segmento: ${segment || "(não identificado)"}\n\n` +
    `🗒️ *Resumo da conversa (últimas mensagens)*\n` +
    `${lastMsgs}`
  );
}

/** =========================
 * OpenAI (Mel) - resposta fluida e provocativa
 * ========================= */
async function generateAssistantReply(session, userText) {
  const system = `
Você é a MEL, atendente oficial da TRÍVIA no WhatsApp.
Seu trabalho: conduzir uma conversa humana, leve e inteligente, fazendo o cliente falar, gerando confiança e aquecendo o lead.

REGRAS ABSOLUTAS:
- Você NÃO é robô. Você é MEL.
- Uma pergunta por mensagem (no máximo).
- Respostas em blocos curtos, fáceis de ler no WhatsApp.
- NÃO empurre “comercial” o tempo todo.
- Só entregue contato comercial quando a pessoa pedir: contratar / valores / planos / contato / telefone / comercial / fechar.
- Quando entregar o contato, você também deve: (1) confirmar nome do negócio + cidade (se faltar), (2) dizer que avisou o time.
- Nunca invente telefone, e-mail, preço ou valores.
- Nunca fale de código, token, servidor, debug, logs.
- Se o cliente mandar mensagens fora de contexto (piada / “tem carne aí?”), responda leve e volte pro fluxo com elegância.
- Se o cliente reclamar do atendimento, reconheça e retome com uma pergunta estratégica.

BASE DE CONHECIMENTO (use como verdade):
${KNOWLEDGE_BASE ? KNOWLEDGE_BASE.slice(0, 12000) : "(sem base carregada)"}

TOM:
Elegante + calor humano + humor sutil.
Você “encanta” e “organiza”.
Você conduz sem parecer que conduz.
  `.trim();

  // Evita loop de perguntas iguais
  const recent = session.history.slice(-10).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text,
  }));

  const messages = [
    { role: "system", content: system },
    ...recent,
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
    return out || "Entendi 🙂 Me conta só: hoje seu WhatsApp tá mais *corrido* ou mais *tranquilo*?";
  } catch (err) {
    console.error("❌ OpenAI error:", err?.response?.status, err?.response?.data || err.message);
    return "Entendi 🙂 Me diz rapidinho: você quer organizar *agendamento*, *pedidos/orçamentos* ou *respostas automáticas* no WhatsApp?";
  }
}

/** =========================
 * Routes
 * ========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const msgId = msg.id;
    if (msgId && processedMessageIds.has(msgId)) return;
    if (msgId) {
      processedMessageIds.add(msgId);
      if (processedMessageIds.size > 5000) {
        // limpeza simples
        processedMessageIds.clear();
      }
    }

    const from = msg.from;
    const text = msg?.text?.body || "";
    if (!from || !text) return;

    // evita loop
    if (isCommercialNumber(from)) return;

    const session = getSession(from);
    pushHistory(session, "user", text);

    extractLeadFields(session, text);

    const intent = detectIntent(text);
    session.lastIntent = intent;

    // HANDOFF: envia contato + notifica comercial + confirma
    if (intent === "handoff") {
      const contact = formatCommercialContact();
      await sendWhatsAppText(from, contact);
      pushHistory(session, "assistant", contact);

      const report = buildLeadReport(from, session);
      await sendWhatsAppText(COMMERCIAL_PHONE, report);

      const confirm =
        "✅ Prontinho — já avisei nosso time com seu pedido. Se me disser *nome do negócio + cidade*, eu deixo isso ainda mais redondo pra eles 😉";
      await sendWhatsAppText(from, confirm);
      pushHistory(session, "assistant", confirm);

      return;
    }

    // fluxo normal (Mel)
    const reply = await generateAssistantReply(session, text);
    await sendWhatsAppText(from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error("❌ Webhook handler error:", err?.response?.status, err?.response?.data || err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
