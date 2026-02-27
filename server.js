"use strict";

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===== ENV =====
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const GRAPH_VERSION = (process.env.GRAPH_VERSION || "v20.0").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.warn("⚠️ Faltando env: VERIFY_TOKEN / WHATSAPP_TOKEN / PHONE_NUMBER_ID");
}
if (!OPENAI_API_KEY) {
  console.warn("⚠️ Faltando env: OPENAI_API_KEY (IA não vai responder com OpenAI)");
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== Util =====
const norm = (s) => (s || "").toString().trim();
const lower = (s) => norm(s).toLowerCase();

function isGreeting(t) {
  const x = lower(t);
  return ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "eai", "e aí", "opa"].includes(x);
}

function isIdentityQuestion(t) {
  // Perguntas diretas sobre ser IA/robô
  const x = lower(t);
  const patterns = [
    "você é ia",
    "vc é ia",
    "voce é ia",
    "isso é ia",
    "é ia",
    "é um robô",
    "é um robo",
    "você é robô",
    "vc é robô",
    "você é uma máquina",
    "é uma máquina",
    "é uma pessoa",
    "é humano",
    "é atendente real",
    "é bot",
    "é chatbot",
  ];
  return patterns.some((p) => x.includes(p));
}

// ===== Trava de escopo (hard gate) =====
// Regra: se NÃO estiver no universo TRÍVIA/atendimento/automação, a Mel NÃO responde o tema.
// Ela redireciona com elegância para atendimento/rotina do negócio.
function isInTriviaScope(text) {
  const t = lower(text);

  // Permite saudações e frases curtas (pra conversa fluir)
  if (t.length <= 14) return true;

  const allowed = [
    // TRÍVIA / serviço
    "trívia", "trivia", "mel", "atendimento", "cliente", "whatsapp", "wpp", "whats",
    "automação", "automacao", "bot", "chatbot", "triagem", "fila", "sac", "suporte",
    "agendamento", "agenda", "pedido", "pedidos", "orçamento", "orcamento",
    "relatório", "relatorio", "módulo", "modulo", "plano", "planos", "preço", "preco",
    "valor", "mensalidade", "contratar", "implantação", "implantacao", "setup",
    "integração", "integracao", "api", "meta", "cloud api", "business", "crm",
    "lead", "leads", "funil", "instagram", "facebook", "marketing", "direct", "dm",
    "responder", "resposta", "mensagem", "mensagens", "padrão", "padrao", "tempo de resposta",
    "sla", "organizar", "organização", "organizacao", "equipe", "encaminhar", "humano",
  ];

  return allowed.some((k) => t.includes(k));
}

function outOfScopeReply() {
  // Curto, humano, sem bronca, sem responder o tema fora do escopo
  return (
    "Haha 😄 eu até curto conversar sobre isso…\n" +
    "mas aqui eu fico no universo de *atendimento* e *rotina com clientes*.\n\n" +
    "Me conta: hoje o seu atendimento tá mais *tranquilo* ou mais *correria*?"
  );
}

// ===== Abertura (não comercial, conexão humana) =====
function melOpening() {
  return (
    "Oi 😊\n\n" +
    "Mel aqui.\n" +
    "Prometo que a conversa vai ser leve — sem script engessado.\n\n" +
    "Como você tá hoje?"
  );
}

// ===== Revelação (só se perguntarem) =====
function melIdentityAnswer() {
  return (
    "Boa pergunta 😊\n\n" +
    "Eu sou a Mel — faço parte da TRÍVIA.\n" +
    "Eu sou uma atendente criada com tecnologia pra conversar de um jeito natural.\n\n" +
    "Se você quiser, a gente volta pro que importa: como tá seu atendimento por aí?"
  );
}

// ===== WhatsApp Send =====
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
}

// ===== Dedup (Meta reenviando evento) =====
const seenMsgIds = new Map(); // id -> timestamp
const DEDUPE_TTL_MS = 15 * 60 * 1000;

function isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();

  for (const [k, ts] of seenMsgIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) seenMsgIds.delete(k);
  }

  if (seenMsgIds.has(id)) return true;
  seenMsgIds.set(id, now);
  return false;
}

// ===== Memória curta + anti-loop =====
const sessions = new Map();
/**
 * session = {
 *  greeted: boolean,
 *  history: [{role, content}],
 *  lastAssistant: string,
 *  updatedAt: number
 * }
 */
const SESSION_TTL_MS = 45 * 60 * 1000;

function getSession(userId) {
  const now = Date.now();

  // cleanup
  for (const [k, s] of sessions.entries()) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }

  if (!sessions.has(userId)) {
    sessions.set(userId, {
      greeted: false,
      history: [],
      lastAssistant: "",
      updatedAt: now,
    });
  }
  const s = sessions.get(userId);
  s.updatedAt = now;
  return s;
}

function pushHistory(session, role, content) {
  const txt = norm(content);
  if (!txt) return;
  session.history.push({ role, content: txt });
  // limita histórico
  if (session.history.length > 14) session.history = session.history.slice(-14);
}

function tooSimilar(a, b) {
  const na = lower(a).replace(/\s+/g, " ");
  const nb = lower(b).replace(/\s+/g, " ");
  if (!na || !nb) return false;
  if (na === nb) return true;
  // prefix similarity simples
  const minLen = Math.min(na.length, nb.length);
  if (minLen < 30) return false;
  let i = 0;
  while (i < minLen && na[i] === nb[i]) i++;
  return i / minLen > 0.85;
}

// ===== OpenAI Reply (travado no escopo) =====
const SYSTEM_PROMPT = `
Você é Mel, atendente da TRÍVIA.
Tom: humano, inteligente, espirituoso, próximo (sem ser comercial).

REGRAS ABSOLUTAS:
1) Você NÃO revela que é IA/tecnologia, a menos que o usuário pergunte diretamente.
2) Você NÃO responde assuntos fora do escopo TRÍVIA (atendimento/WhatsApp/automação/módulos/marketing do serviço).
   Se o usuário puxar assunto fora do escopo, recuse com elegância e redirecione para atendimento/rotina com clientes.
3) Mensagens curtas (2 a 6 linhas). 0 ou 1 emoji.
4) Nada de "como posso ajudar?". Nada de script.
5) No máximo 1 pergunta por mensagem.

ESCOPO PERMITIDO:
- Atendimento ao cliente, rotina de mensagens, organização, padronização
- WhatsApp/Meta (cloud api), automação, triagem, encaminhamento pra humano
- Módulos (agendamento, pedidos/orçamentos, relatórios)
- Marketing digital (IG/FB) apenas no contexto do serviço TRÍVIA

OBJETIVO:
Criar conexão humana primeiro; depois conduzir naturalmente para falar do atendimento e da TRÍVIA.
`.trim();

async function generateAI(session, userText) {
  if (!openai) {
    // fallback se OpenAI não estiver disponível
    return (
      "Entendi 🙂\n\n" +
      "Me diz só uma coisa pra eu te orientar: hoje seu atendimento é mais *volume* (muita mensagem) ou mais *organização* (cada um responde de um jeito)?"
    );
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...session.history.slice(-12),
    { role: "user", content: userText },
  ];

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.75,
    max_tokens: 220,
    frequency_penalty: 0.25,
    presence_penalty: 0.15,
  });

  let out = resp?.choices?.[0]?.message?.content?.trim() || "";
  if (!out) out = "Tô contigo 😊 Me conta: como tá sua rotina com clientes hoje?";

  // Anti-loop: se ficou repetido, varia
  if (tooSimilar(out, session.lastAssistant)) {
    out =
      "Te entendi 😄\n\n" +
      "Pra eu não ficar no genérico: hoje você se sente mais travado por *tempo* ou por *bagunça* nas mensagens?";
  }

  return out;
}

// ===== Webhook Verify (GET) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Health =====
app.get("/", (_req, res) => res.status(200).send("Mel/TRÍVIA online ✅"));

// ===== Webhook Receive (POST) =====
app.post("/webhook", (req, res) => {
  // responde rápido para a Meta
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const body = req.body;
      const value = body?.entry?.[0]?.changes?.[0]?.value;

      // ignora status (delivered/read)
      if (value?.statuses) return;

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const msgId = msg.id;

      if (!from || !msgId) return;
      if (isDuplicate(msgId)) return;

      const session = getSession(from);

      // só texto por enquanto
      if (msg.type !== "text") {
        const reply =
          "Recebi 🙂\n" +
          "Por enquanto eu entendo melhor *mensagens em texto*.\n\n" +
          "Me manda por escrito: como tá seu atendimento hoje?";
        if (!tooSimilar(reply, session.lastAssistant)) {
          await sendWhatsAppText(from, reply);
          session.lastAssistant = reply;
          pushHistory(session, "assistant", reply);
        }
        return;
      }

      const userText = norm(msg.text?.body || "");
      if (!userText) return;

      // Guarda usuário no histórico
      pushHistory(session, "user", userText);

      // 1) Se perguntarem “é IA?” => responde com transparência elegante
      if (isIdentityQuestion(userText)) {
        const reply = melIdentityAnswer();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.greeted = true;
        return;
      }

      // 2) Primeiro contato: abertura humana (não comercial)
      if (!session.greeted) {
        const reply = melOpening();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.greeted = true;
        return;
      }

      // 3) Hard gate de escopo ANTES da IA
      if (!isInTriviaScope(userText)) {
        const reply = outOfScopeReply();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        return;
      }

      // 4) Se for só cumprimento depois do greeted, responde curto e puxa conversa humana
      if (isGreeting(userText)) {
        const reply = "Oi 😊\n\nComo você tá hoje — de verdade?";
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        return;
      }

      // 5) IA (apenas no escopo)
      const reply = await generateAI(session, userText);
      await sendWhatsAppText(from, reply);
      session.lastAssistant = reply;
      pushHistory(session, "assistant", reply);
    } catch (err) {
      console.error("❌ Webhook error:", err?.response?.data || err?.message || err);
      // Não responder nada aqui (já respondemos 200 no início)
    }
  });
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Server rodando na porta", PORT));
