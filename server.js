import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ============================
// Helpers / Paths (ESM)
// ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================
// ENV
// ============================
const PORT = process.env.PORT || 8080;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0"; // <-- importante

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").replace(/\D/g, ""); // ex: 5531997373954

// ============================
// Basic validation logs
// ============================
function mask(s, keep = 4) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= keep) return "*".repeat(str.length);
  return "*".repeat(Math.max(0, str.length - keep)) + str.slice(-keep);
}

console.log("✅ TRÍVIA iniciando...");
console.log("PORT:", PORT);
console.log("GRAPH_VERSION:", GRAPH_VERSION);
console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? mask(PHONE_NUMBER_ID, 4) : "(vazio)");
console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? mask(WHATSAPP_TOKEN, 6) : "(vazio)");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? mask(OPENAI_API_KEY, 6) : "(vazio)");
console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE ? COMMERCIAL_PHONE : "(vazio)");

// ============================
// Load knowledge base
// ============================
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge", "trivia_base.txt");
let KNOWLEDGE_TEXT = "";

async function loadKnowledge() {
  try {
    KNOWLEDGE_TEXT = await fs.readFile(KNOWLEDGE_PATH, "utf8");
    console.log(`✅ Base carregada (${path.relative(__dirname, KNOWLEDGE_PATH)})`);
  } catch (err) {
    console.log(`⚠️ Base não encontrada em ${KNOWLEDGE_PATH}. (ok, mas recomendo criar)`);
    KNOWLEDGE_TEXT = "";
  }
}

// ============================
// Express
// ============================
const app = express();
app.use(express.json({ limit: "2mb" }));

// ============================
// In-memory state
// ============================

// dedupe: guarda IDs de mensagens recebidas por 10 min
const seenMessageIds = new Map(); // id -> timestamp
const SEEN_TTL_MS = 10 * 60 * 1000;

// conversa curta por contato (wa_id)
const convo = new Map(); // wa_id -> [{role, content}, ...]
const MAX_TURNS = 16;

function cleanupSeen() {
  const now = Date.now();
  for (const [id, ts] of seenMessageIds.entries()) {
    if (now - ts > SEEN_TTL_MS) seenMessageIds.delete(id);
  }
}
setInterval(cleanupSeen, 60 * 1000).unref();

// ============================
// WhatsApp API
// ============================
function waUrl() {
  // ✅ O erro 2500 era porque você estava usando /{id}/messages sem versão
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ WHATSAPP_TOKEN ou PHONE_NUMBER_ID vazio. Não dá pra enviar.");
    return;
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };

  try {
    const res = await axios.post(waUrl(), payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log(`❌ WhatsApp send error ${status || ""}:`, JSON.stringify(data || err.message));
    throw err;
  }
}

function normText(s) {
  return (s || "").toString().trim();
}

function isCommercialIntent(textRaw) {
  const t = normText(textRaw).toLowerCase();
  // ✅ sem enrolar: se pedir contratar / comercial / telefone / falar com humano
  return (
    t.includes("contratar") ||
    t.includes("comercial") ||
    t.includes("telefone") ||
    t.includes("numero") ||
    t.includes("número") ||
    t.includes("falar com") ||
    t.includes("humano") ||
    t.includes("atendente") ||
    t.includes("vendedor") ||
    t.includes("vendas") ||
    t.includes("orçamento") ||
    t.includes("orcamento") ||
    t.includes("preço") ||
    t.includes("preco")
  );
}

function formatPhoneBR(e164digits) {
  // recebe algo tipo 5531997373954
  if (!e164digits) return "";
  const d = e164digits.replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) {
    const cc = "+55";
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    // tenta formatar como celular: 9XXXX-XXXX
    if (rest.length === 9) {
      return `${cc} (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    }
    if (rest.length === 8) {
      return `${cc} (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
    return `${cc} (${ddd}) ${rest}`;
  }
  return `+${d}`;
}

function waMeLink(e164digits) {
  // wa.me exige só dígitos
  const d = (e164digits || "").replace(/\D/g, "");
  if (!d) return "";
  return `https://wa.me/${d}`;
}

// ============================
// OpenAI (Responses API)
// ============================
async function askOpenAI({ wa_id, userText }) {
  if (!OPENAI_API_KEY) {
    return "Estou pronta pra te ajudar 😊\n\nMe diz só: você quer entender melhor os serviços, organizar seu atendimento ou falar com o comercial?";
  }

  const history = convo.get(wa_id) || [];

  const system = `
Você é a Mel, assistente da TRÍVIA (tecnologia e atendimento no WhatsApp).
Fale em português do Brasil, de forma natural, educada e objetiva (ultra profissional).
Nunca discuta “token/chave/api” com clientes.
Foque em entender o cenário do cliente e orientar de forma humana.
Se o cliente pedir comercial/contratar/telefone, responda direto com o contato (sem perguntas extras).
`;

  const kb = KNOWLEDGE_TEXT
    ? `\n\nBase de conhecimento (use quando ajudar):\n${KNOWLEDGE_TEXT.slice(0, 25000)}`
    : "";

  const input = [
    { role: "system", content: system.trim() + kb },
    ...history,
    { role: "user", content: userText }
  ];

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: OPENAI_MODEL,
        input,
        temperature: 0.6,
        max_output_tokens: 350
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 25000
      }
    );

    const out = res.data?.output_text?.trim();
    if (!out) return "Entendi. Me conta só um detalhe: qual é o seu objetivo principal com o WhatsApp hoje — organizar, responder mais rápido ou automatizar parte do atendimento?";

    // atualiza histórico
    const newHistory = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: out }
    ].slice(-MAX_TURNS);

    convo.set(wa_id, newHistory);

    return out;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log(`❌ OpenAI error ${status || ""}:`, JSON.stringify(data || err.message));
    return "Tive uma instabilidade aqui por um instante. Pode repetir sua última mensagem?";
  }
}

// ============================
// Webhook verify (GET)
// ============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ============================
// Webhook receive (POST)
// ============================
app.post("/webhook", async (req, res) => {
  // sempre responde 200 rápido pro Meta não reenviar
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const msgId = msg?.id;
    const from = msg?.from; // wa_id do cliente
    const text = msg?.text?.body || "";

    if (!from) return;

    // dedupe
    if (msgId) {
      if (seenMessageIds.has(msgId)) return;
      seenMessageIds.set(msgId, Date.now());
    }

    const userText = normText(text);
    if (!userText) return;

    // ✅ REGRA: Se pedir comercial/contratar/telefone -> responde direto e encerra o fluxo
    if (isCommercialIntent(userText)) {
      if (!COMMERCIAL_PHONE) {
        await sendWhatsAppText(from, "Perfeito. Vou te colocar com o comercial.\n\nMe chama por aqui que já te direciono.");
        return;
      }

      const phonePretty = formatPhoneBR(COMMERCIAL_PHONE);
      const link = waMeLink(COMMERCIAL_PHONE);

      // 1) manda pro cliente o contato do comercial
      await sendWhatsAppText(
        from,
        `Perfeito. Aqui está o contato do nosso comercial:\n${phonePretty}\n${link}\n\nPode chamar por lá que eles te atendem agora.`
      );

      // 2) tenta avisar o comercial (se falhar, não quebra)
      const leadLine = `📩 Novo pedido de comercial\nCliente: ${from}\nMensagem: "${userText}"\nData: ${new Date().toLocaleString("pt-BR")}`;
      try {
        await sendWhatsAppText(COMMERCIAL_PHONE, leadLine);
      } catch (e) {
        console.log("⚠️ Não consegui avisar o comercial via API (normal se não estiver em janela 24h).");
      }

      return;
    }

    // fluxo normal com OpenAI
    const reply = await askOpenAI({ wa_id: from, userText });
    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.log("❌ Webhook handler error:", err?.message || err);
  }
});

// ============================
// Health
// ============================
app.get("/", (req, res) => res.status(200).send("TRÍVIA webhook OK"));

// ============================
// Start
// ============================
await loadKnowledge();

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
