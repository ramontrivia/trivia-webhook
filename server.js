// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Notificação Comercial
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";

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

// Base / Knowledge (opcional)
const BASE_PATH = path.join(process.cwd(), "knowledge", "trivia_base.txt");
let KNOWLEDGE_BASE = "";
try {
  KNOWLEDGE_BASE = fs.readFileSync(BASE_PATH, "utf8");
  console.log(`✅ Base carregada (${BASE_PATH})`);
} catch {
  console.log("ℹ️ Sem base local (knowledge/trivia_base.txt). Seguindo sem base.");
}

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
 *   lead: { company, city, state, segment },
 *   history: [{role, text, ts}],
 *   lastIntent: string,
 * }
 */

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      lead: { company: "", city: "", state: "", segment: "" },
      history: [],
      lastIntent: "",
    });
  }
  return sessions.get(userId);
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, ts: new Date().toISOString() });
  // limita pra não explodir memória
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
  // ✅ Corrige o erro: precisa incluir /vXX.X/
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
  // Evita loop caso o comercial responda pro BOT e o BOT tente notificar de novo
  return COMMERCIAL_PHONE && normalizePhone(from) === COMMERCIAL_PHONE;
}

/** =========================
 * Intent / routing (regras)
 * ========================= */
const TRIGGER_HUMAN = [
  "contratar",
  "quero contratar",
  "preço",
  "valores",
  "plano",
  "assinar",
  "comercial",
  "telefone do comercial",
  "falar com comercial",
  "vendedor",
  "atendente humano",
  "quero falar com alguém",
  "quero comprar",
  "quero fechar",
];

function detectIntent(text) {
  const t = (text || "").toLowerCase();

  // prioridade: contratar/telefone
  if (TRIGGER_HUMAN.some((k) => t.includes(k))) return "handoff";

  // intenção informativa
  if (t.includes("agendamento")) return "agendamento";
  if (t.includes("pedido") || t.includes("orçamento") || t.includes("orcamento")) return "pedidos";
  if (t.includes("relatório") || t.includes("relatorio")) return "relatorios";

  return "general";
}

function extractLeadFields(session, userText) {
  // Heurística simples: se a pessoa mandar algo tipo "Salão X, Mateus Leme MG"
  // tenta capturar.
  const t = userText.trim();

  // tenta pegar UF
  const ufMatch = t.match(/\b([A-Z]{2})\b/);
  const maybeUF = ufMatch?.[1] || "";

  // tenta pegar cidade (bem simples): procura " em <Cidade>" ou "<Cidade> <UF>"
  let city = session.lead.city;
  let state = session.lead.state;

  // padrão "... <Cidade> <UF>"
  const cityUf = t.match(/([A-Za-zÀ-ÿ\s]+)\s+([A-Z]{2})\b/);
  if (cityUf && !state) {
    city = city || cityUf[1].trim();
    state = state || cityUf[2].trim();
  }

  // se tiver "sou um salão", "barbearia", etc.
  const seg =
    t.toLowerCase().includes("salão") || t.toLowerCase().includes("salao")
      ? "Salão/Beleza"
      : t.toLowerCase().includes("barbearia")
      ? "Barbearia"
      : t.toLowerCase().includes("clínica") || t.toLowerCase().includes("clinica")
      ? "Clínica"
      : session.lead.segment;

  // empresa: se a frase tiver algo como "Empresa: X" ou só o primeiro trecho antes da vírgula
  let company = session.lead.company;
  const companyMatch = t.match(/empresa[:\s]+(.+)/i);
  if (companyMatch) company = companyMatch[1].trim();
  else if (t.includes(",")) {
    const first = t.split(",")[0].trim();
    // evita capturar coisas muito genéricas
    if (first.length >= 3 && first.length <= 60) company = company || first;
  }

  session.lead.company = company;
  session.lead.city = city;
  session.lead.state = state;
  session.lead.segment = seg;
}

function formatCommercialContact() {
  // Você pode trocar o texto aqui do jeito que quiser
  const phonePretty = COMMERCIAL_PHONE
    ? `+${COMMERCIAL_PHONE.slice(0, 2)} (${COMMERCIAL_PHONE.slice(2, 4)}) ${COMMERCIAL_PHONE.slice(
        4,
        9
      )}-${COMMERCIAL_PHONE.slice(9)}`
    : "";
  return `Perfeito. Aqui está o contato do nosso comercial:\n\n${phonePretty}\nhttps://wa.me/${COMMERCIAL_PHONE}\n\nPode chamar por lá que eles te atendem agora.`;
}

function buildLeadReport(userId, session) {
  const { company, city, state, segment } = session.lead;
  const lastMsgs = session.history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Cliente" : "TRÍVIA"}: ${m.text}`)
    .join("\n");

  const now = new Date().toLocaleString("pt-BR");

  return (
    `📌 *Novo lead solicitou comercial*\n` +
    `🕒 ${now}\n` +
    `👤 WhatsApp (ID): ${userId}\n` +
    `🏢 Empresa: ${company || "(não informado)"}\n` +
    `📍 Cidade/UF: ${city || "(não informado)"}${state ? "/" + state : ""}\n` +
    `🏷️ Segmento: ${segment || "(não identificado)"}\n\n` +
    `🗒️ *Resumo da conversa (últimas mensagens)*\n` +
    `${lastMsgs}`
  );
}

/** =========================
 * OpenAI (resposta natural)
 * ========================= */
async function generateAssistantReply(session, userText) {
  // “tom” e regras para não ficar empurrando pro comercial toda hora
  const system = `
Você é a TRÍVIA, uma atendente virtual brasileira, elegante, humana, objetiva e cordial.
Você ajuda o cliente a entender como a TRÍVIA se aplica ao negócio dele com exemplos e perguntas inteligentes.

Regras:
- NÃO repita a mesma pergunta em loop.
- Faça no máximo 1 pergunta por mensagem.
- Seja natural e fluida (evite "vamos encaminhar para o comercial" toda hora).
- Só ofereça o contato do comercial quando o cliente pedir "contratar/valores/telefone/comercial" ou quando estiver claramente pronto para fechar.
- Se o cliente disser que quer "só contratar", dê o caminho direto.
- Use linguagem profissional, sem exageros.

Contexto (base interna pode ajudar):
${KNOWLEDGE_BASE ? KNOWLEDGE_BASE.slice(0, 6000) : "(sem base)"}
  `.trim();

  const messages = [
    { role: "system", content: system },
    // histórico recente
    ...session.history.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    })),
    { role: "user", content: userText },
  ];

  try {
    // Chat Completions simples (funciona bem)
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.5,
        max_tokens: 220,
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
    return out || "Entendi. Me conta um pouco mais para eu te orientar do jeito certo 🙂";
  } catch (err) {
    console.error("❌ OpenAI error:", err?.response?.status, err?.response?.data || err.message);
    return "Entendi. Só um instante — vou te orientar por aqui mesmo. Você quer agendamento, pedidos/orçamentos ou atendimento automático no WhatsApp?";
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
    // HANDOFF (contratar/telefone)
    // =============================
    if (intent === "handoff") {
      // 1) manda pro cliente o contato do comercial
      const contact = formatCommercialContact();
      await sendWhatsAppText(from, contact);
      pushHistory(session, "assistant", contact);

      // 2) manda relatório pro comercial (notificação)
      const report = buildLeadReport(from, session);
      await sendWhatsAppText(COMMERCIAL_PHONE, report);

      // 3) (opcional) confirma ao cliente que avisamos o time (sem travar)
      const confirm = "✅ Perfeito — já te passei o contato e também avisei nosso time com seus dados para agilizar o atendimento.";
      await sendWhatsAppText(from, confirm);
      pushHistory(session, "assistant", confirm);

      return;
    }

    // =============================
    // Fluxo natural (sem empurrar)
    // =============================
    const reply = await generateAssistantReply(session, text);
    await sendWhatsAppText(from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error("❌ Webhook handler error:", err?.response?.status, err?.response?.data || err.message);
  }
});

/** =========================
 * Start
 * ========================= */
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
