// server.js (ESM) — compatível com package.json: { "type": "module" }

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// =========================
// ENV
// =========================
const PORT = process.env.PORT || 8080;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

// Comercial (seu WhatsApp que recebe notificação)
const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").replace(/\D/g, ""); // ex: 5531997373954

// OpenAI (já existe no seu projeto)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// =========================
// KNOWLEDGE BASE (opcional)
// =========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KB_PATH = path.join(__dirname, "knowledge", "trivia_base.txt");
let KNOWLEDGE_BASE = "";
try {
  KNOWLEDGE_BASE = fs.readFileSync(KB_PATH, "utf-8");
  console.log(`✅ Base carregada (${path.relative(__dirname, KB_PATH)})`);
} catch (e) {
  console.log("⚠️ Base não encontrada (knowledge/trivia_base.txt). Seguindo sem KB.");
}

// =========================
// SESSION STORE (memória simples)
// =========================
/**
 * sessions.get(userWaId) = {
 *   startedAt: ISO,
 *   lastAt: ISO,
 *   messages: [{ role: "user"|"assistant", text, ts }],
 *   lead: { name, city, state, business },
 *   flags: { sentCommercialContact: bool, sentCommercialReport: bool }
 * }
 */
const sessions = new Map();

function getSession(userWaId) {
  if (!sessions.has(userWaId)) {
    sessions.set(userWaId, {
      startedAt: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      messages: [],
      lead: { name: "", city: "", state: "", business: "" },
      flags: { sentCommercialContact: false, sentCommercialReport: false },
    });
  }
  const s = sessions.get(userWaId);
  s.lastAt = new Date().toISOString();
  return s;
}

// limpeza simples (não deixar crescer infinito)
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions.entries()) {
    const ageMin = (now - new Date(s.lastAt).getTime()) / 60000;
    if (ageMin > 180) sessions.delete(k); // 3h sem falar -> remove
  }
}, 10 * 60 * 1000);

// =========================
// HELPERS
// =========================
function normalize(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function looksLikeHireIntent(text) {
  const t = normalize(text);
  return (
    t.includes("contratar") ||
    t.includes("quero contratar") ||
    t.includes("como faco pra contratar") ||
    t.includes("como faço pra contratar") ||
    t.includes("telefone do comercial") ||
    t.includes("contato do comercial") ||
    t.includes("falar com o comercial") ||
    t.includes("passa o numero") ||
    t.includes("passa o telefone") ||
    t.includes("quero apenas contratar")
  );
}

function extractSimpleLeadData(session, userText) {
  // heurística leve: se o user manda "Salão X. de Cidade UF"
  // não é perfeito — por isso depois a gente pede pro OpenAI extrair melhor (se disponível)
  const txt = userText || "";
  // tenta pegar UF
  const uf = txt.match(/\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/i);
  if (uf) session.lead.state = uf[1].toUpperCase();

  // tenta pegar "salao", "barbearia", "clinica" etc como "business"
  const bizHint = txt.match(/(salao|salão|barbearia|clinica|clínica|loja|restaurante|escritorio|escritório|empresa)\s+([^\n,.]+)/i);
  if (bizHint && !session.lead.business) {
    session.lead.business = (bizHint[0] || "").trim();
  }

  // tenta pegar cidade (bem simples)
  const cityHint = txt.match(/de\s+([A-Za-zÀ-ÿ\s]{3,})\s*(?:-|,)?\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)?/i);
  if (cityHint && !session.lead.city) {
    session.lead.city = (cityHint[1] || "").trim();
    if (cityHint[2]) session.lead.state = cityHint[2].toUpperCase();
  }
}

async function sendWhatsAppMessage(toPhoneE164Digits, text) {
  // toPhoneE164Digits: só números, ex: 5531997373954
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toPhoneE164Digits,
    type: "text",
    text: { body: text },
  };

  try {
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 20000,
    });
    return true;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log(`❌ WhatsApp send error ${status}:`, JSON.stringify(data || err.message));
    return false;
  }
}

async function openaiExtractLead(session) {
  // Extrai nome/empresa/cidade/estado + resumo curto do interesse
  if (!OPENAI_API_KEY) return null;

  const lastUserMessages = session.messages
    .filter((m) => m.role === "user")
    .slice(-12)
    .map((m) => `- ${m.text}`)
    .join("\n");

  const sys = `
Você é um assistente que extrai dados de um lead a partir de uma conversa.
Retorne APENAS JSON válido.
Campos:
{
 "business_name": string,
 "city": string,
 "state": string,
 "person_name": string,
 "goal": string
}
Se não houver dado, use "".
`.trim();

  const user = `
Conversa (últimas mensagens do cliente):
${lastUserMessages}
`.trim();

  try {
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        temperature: 0.1,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 25000,
      }
    );

    const content = r?.data?.choices?.[0]?.message?.content?.trim() || "";
    const json = JSON.parse(content);
    return json;
  } catch (e) {
    // se falhar, tudo bem — fallback vem abaixo
    return null;
  }
}

function buildLeadReport(session, extracted) {
  const lead = session.lead || {};
  const business = extracted?.business_name || lead.business || "";
  const city = extracted?.city || lead.city || "";
  const state = extracted?.state || lead.state || "";
  const person = extracted?.person_name || lead.name || "";
  const goal = extracted?.goal || "Pediu contato do comercial / contratação.";

  const lastMessages = session.messages
    .slice(-14)
    .map((m) => `${m.role === "user" ? "Cliente" : "TRÍVIA"}: ${m.text}`)
    .join("\n");

  const when = new Date().toLocaleString("pt-BR");

  return `
📩 *NOVO LEAD — TRÍVIA*
🕒 ${when}

👤 Nome: ${person || "(não informado)"}
🏢 Empresa/Negócio: ${business || "(não informado)"}
📍 Cidade/UF: ${city || "(não informado)"}${state ? "/" + state : ""}

🎯 Interesse: ${goal}

🧾 *Trecho da conversa (últimas mensagens):*
${lastMessages}
`.trim();
}

// =========================
// ROTAS META WEBHOOK
// =========================

// Verificação do webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receber mensagens
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Confirma recebimento pra Meta rápido
    res.sendStatus(200);

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const from = msg?.from; // wa_id do cliente (só números)
    const text = msg?.text?.body || "";

    if (!from || !text) return;

    const session = getSession(from);
    session.messages.push({ role: "user", text, ts: new Date().toISOString() });

    // Heurística pra ir capturando dados
    extractSimpleLeadData(session, text);

    // =========================
    // 1) INTENÇÃO: CONTRATAR / COMERCIAL
    // =========================
    if (looksLikeHireIntent(text)) {
      // evita loop/repetição
      if (!session.flags.sentCommercialContact) {
        session.flags.sentCommercialContact = true;

        // manda pro cliente o contato do comercial
        const prettyPhone = COMMERCIAL_PHONE
          ? `+${COMMERCIAL_PHONE.replace(/^(\d{2})(\d{2})(\d{5})(\d{4}).*$/, "$1 ($2) $3-$4")}`
          : "(número não configurado)";

        const waMe = COMMERCIAL_PHONE ? `https://wa.me/${COMMERCIAL_PHONE}` : "";

        const clientReply = `
Perfeito. Aqui está o contato do nosso comercial:

${prettyPhone}
${waMe}

Pode chamar por lá que eles te atendem agora.
`.trim();

        await sendWhatsAppMessage(from, clientReply);
        session.messages.push({ role: "assistant", text: clientReply, ts: new Date().toISOString() });
      }

      // =========================
      // 2) NOTIFICAÇÃO + RELATÓRIO pro COMERCIAL
      // =========================
      if (!session.flags.sentCommercialReport) {
        session.flags.sentCommercialReport = true;

        // Extrai melhor via OpenAI (se disponível). Se não, segue com fallback.
        const extracted = await openaiExtractLead(session);

        const report = buildLeadReport(session, extracted);

        if (COMMERCIAL_PHONE) {
          const ok = await sendWhatsAppMessage(COMMERCIAL_PHONE, report);

          // Se falhar: geralmente é porque o comercial não abriu janela de 24h.
          if (!ok) {
            console.log("⚠️ Não consegui notificar o comercial. Verifique se o número do comercial já mandou mensagem pro número oficial da TRÍVIA (janela 24h) ou use template.");
          }
        } else {
          console.log("⚠️ COMMERCIAL_PHONE não configurado.");
        }
      }

      return;
    }

    // =========================
    // 3) FLUXO NORMAL (resposta padrão via OpenAI + KB)
    // =========================
    const assistantText = await generateAssistantReply(text, session);
    if (assistantText) {
      await sendWhatsAppMessage(from, assistantText);
      session.messages.push({ role: "assistant", text: assistantText, ts: new Date().toISOString() });
    }
  } catch (err) {
    console.log("❌ Webhook handler error:", err?.message || err);
    // já respondemos 200 acima, então só loga
  }
});

// =========================
// GERAR RESPOSTA (OpenAI + KB)
// =========================
async function generateAssistantReply(userText, session) {
  if (!OPENAI_API_KEY) {
    return "No momento estou com instabilidade. Pode repetir sua mensagem, por favor?";
  }

  // contexto curto (não deixar gigantesco)
  const history = session.messages.slice(-12).map((m) => ({
    role: m.role,
    content: m.text,
  }));

  const system = `
Você é a TRÍVIA, uma central de atendimento inteligente e humanizada no WhatsApp.
Regras:
- Seja direto, educado, ultra profissional.
- Nunca invente links oficiais.
- Quando o cliente pedir para contratar, contato do comercial, telefone do comercial ou falar com comercial: responda curto e encaminhe (o servidor já faz isso).
- Mantenha foco em atendimento, WhatsApp e automação.
`.trim();

  const kb = KNOWLEDGE_BASE
    ? `\n\nBase de conhecimento (use apenas como referência):\n${KNOWLEDGE_BASE.slice(0, 12000)}`
    : "";

  try {
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        temperature: 0.4,
        messages: [
          { role: "system", content: system + kb },
          ...history,
          { role: "user", content: userText },
        ],
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 25000,
      }
    );

    const content = r?.data?.choices?.[0]?.message?.content?.trim();
    return content || "Perfeito. Como posso te ajudar?";
  } catch (e) {
    return "Tive uma instabilidade agora. Pode repetir sua mensagem em uma frase, por favor?";
  }
}

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`PORT: ${PORT}`);
  console.log(`GRAPH_VERSION: ${GRAPH_VERSION}`);
  console.log(`PHONE_NUMBER_ID: ${String(PHONE_NUMBER_ID || "").slice(0, 3)}***${String(PHONE_NUMBER_ID || "").slice(-4)}`);
  console.log(`COMMERCIAL_PHONE: ${COMMERCIAL_PHONE || "(vazio)"}`);
});
