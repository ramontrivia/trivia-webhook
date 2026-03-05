// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Notificação Comercial
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
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ex: 938629096008107
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || ""); // ex: 5531997373954

/** =========================
 * Knowledge: carregar TODOS os .txt da pasta /knowledge
 * ========================= */
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
let KNOWLEDGE_BASE = "";

// detectar cliente baseado no número do WhatsApp
function detectClient(phoneNumberId) {
  if (phoneNumberId === process.env.PHONE_NUMBER_ID_BUSCAI) {
    return "cliente_buscai";
  }

  return "trivia";
}

function loadAllKnowledgeTxt() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      console.log("ℹ️ Pasta /knowledge não encontrada. Seguindo sem base.");
      return "";
    }

    const files = fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

    if (!files.length) {
      console.log("ℹ️ Nenhum .txt encontrado em /knowledge. Seguindo sem base.");
      return "";
    }

    const parts = [];
    for (const file of files) {
      const full = path.join(KNOWLEDGE_DIR, file);
      const content = fs.readFileSync(full, "utf8");
      parts.push(
        `\n\n====================\nARQUIVO: ${file}\n====================\n${content}\n`
      );
    }

    console.log(`✅ Knowledge carregado: ${files.length} arquivo(s) .txt`);
    return parts.join("\n");
  } catch (e) {
    console.log("⚠️ Falha ao carregar knowledge:", e.message);
    return "";
  }
}

KNOWLEDGE_BASE = loadAllKnowledgeTxt();

/** =========================
 * Guards / Validations
 * ========================= */
function assertEnv() {
  const missing = [];
  if (!PHONE_NUMBER_ID) missing.push("PHONE_NUMBER_ID");
  if (!WHATSAPP_TOKEN) missing.push("WHATSAPP_TOKEN");
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
  console.log("PHONE_NUMBER_ID:", mask(PHONE_NUMBER_ID));
  console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE);
  console.log("WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN));
  console.log("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
  console.log("OPENAI_MODEL:", OPENAI_MODEL);
}
assertEnv();

/** =========================
 * In-memory state (simples)
 * ========================= */
const sessions = new Map();
/**
 * session = {
 *   lead: { name, company, city, state, segment },
 *   history: [{role, text, ts}],
 *   lastIntent: string,
 *   leadNotified: boolean
 * }
 */

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      lead: { name: "", company: "", city: "", state: "", segment: "" },
      history: [],
      lastIntent: "",
      leadNotified: false,
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

function graphMessagesUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppText(to, body) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  try {
    const res = await axios.post(graphMessagesUrl(), payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(`❌ WhatsApp send error ${status}:`, JSON.stringify(data || err.message));
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
  if (t.includes("pedido") || t.includes("orçamento") || t.includes("orcamento")) return "pedidos";
  if (t.includes("relatório") || t.includes("relatorio")) return "relatorios";

  return "general";
}

/** =========================
 * Lead extraction (heurístico)
 * ========================= */
function extractLeadFields(session, userText) {
  const t = userText.trim();

  // UF
  const ufMatch = t.match(/\b([A-Z]{2})\b/);
  const maybeUF = ufMatch?.[1] || "";

  // cidade/UF: "... <Cidade> <UF>"
  const cityUf = t.match(/([A-Za-zÀ-ÿ\s]+)\s+([A-Z]{2})\b/);
  if (cityUf) {
    if (!session.lead.city) session.lead.city = cityUf[1].trim();
    if (!session.lead.state) session.lead.state = cityUf[2].trim();
  } else if (maybeUF && !session.lead.state) {
    session.lead.state = maybeUF;
  }

  // segmento
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

  // empresa: antes da vírgula
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

  return `Fechou 😊 Aqui está o contato do nosso comercial:\n\n${phonePretty}\nhttps://wa.me/${COMMERCIAL_PHONE}\n\nPode chamar por lá que eles te atendem agora.`;
}

function buildLeadReport(userId, session) {
  const { name, company, city, state, segment } = session.lead;
  const lastMsgs = session.history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Cliente" : "MEL"}: ${m.text}`)
    .join("\n");

  const now = new Date().toLocaleString("pt-BR");

  return (
    `📌 *Novo lead TRÍVIA (quente)*\n` +
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

async function notifyCommercialLead(from, session) {
  // Evita spam múltiplo
  if (session.leadNotified) return;

  const report = buildLeadReport(from, session);

  try {
    await sendWhatsAppText(COMMERCIAL_PHONE, report);
    session.leadNotified = true;
    console.log("✅ Lead enviado ao comercial.");
  } catch (e) {
    // Aqui é onde você vai ver o motivo REAL no log do Railway (ex: 470/131047/24h window)
    console.error("❌ Falha ao enviar lead ao comercial. Provável janela 24h fechada ou número não opt-in.");
  }
}

/** =========================
 * OpenAI (MEL - mais humana)
 * ========================= */
async function generateAssistantReply(session, userText) {
  // MEL: humor leve, humana, provoca conversa, mini simulação antes de comercial
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
    return out || "Entendi 🙂 Me conta só uma coisa: seu WhatsApp hoje tá mais tranquilo ou tá uma correria?";
  } catch (err) {
    console.error("❌ OpenAI error:", err?.response?.status, err?.response?.data || err.message);
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
  // responde rápido pro Meta não reenviar
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // wa_id do cliente
    const text = msg?.text?.body || "";
    if (!from || !text) return;

    // ignora mensagens vindas do próprio comercial (evita loop)
    if (isCommercialNumber(from)) return;

    const session = getSession(from);
    pushHistory(session, "user", text);

    // tenta capturar dados do lead quando aparecerem
    extractLeadFields(session, text);

    const intent = detectIntent(text);
    session.lastIntent = intent;

    // =============================
    // HANDOFF (quente: contratar/telefone/planos)
    // =============================
    if (intent === "handoff") {
      // 1) manda contato comercial ao cliente automaticamente
      const contact = formatCommercialContact();
      await sendWhatsAppText(from, contact);
      pushHistory(session, "assistant", contact);

      // 2) tenta mandar relatório pro comercial (pode falhar se janela 24h fechada)
      await notifyCommercialLead(from, session);

      // 3) confirma ao cliente (sem travar)
      const confirm =
        "Prontinho ✅ Se você me disser o *nome do negócio + cidade*, eu já aviso o time com tudo mastigado pra te atender mais rápido 😉";
      await sendWhatsAppText(from, confirm);
      pushHistory(session, "assistant", confirm);

      return;
    }

    // =============================
    // Fluxo natural (MEL)
    // =============================
    const reply = await generateAssistantReply(session, text);
    await sendWhatsAppText(from, reply);
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
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});

