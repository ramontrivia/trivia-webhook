"use strict";

/**
 * TRÍVIA - Mel (conversa humana) + WhatsApp Cloud API + OpenAI
 * Um único arquivo server.js para Railway.
 *
 * ENV obrigatórias:
 * - VERIFY_TOKEN
 * - WHATSAPP_TOKEN
 * - PHONE_NUMBER_ID
 * - OPENAI_API_KEY
 *
 * ENV opcionais:
 * - OPENAI_MODEL (default: gpt-4o-mini)
 * - GRAPH_VERSION (default: v20.0)
 */

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===== ENV =====
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const GRAPH_VERSION = (process.env.GRAPH_VERSION || "v20.0").trim();
const PORT = process.env.PORT || 8080;

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.warn("⚠️ Faltando env: VERIFY_TOKEN / WHATSAPP_TOKEN / PHONE_NUMBER_ID");
}
if (!OPENAI_API_KEY) {
  console.warn("⚠️ Faltando env: OPENAI_API_KEY (IA não vai funcionar)");
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== UTIL =====
const norm = (s) => (s || "").toString().trim();
const lower = (s) =>
  norm(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

// ====== DEDUPE por message.id (evita responder duplicado) ======
const seen = new Map(); // msgId -> timestamp
const DEDUPE_TTL_MS = 15 * 60 * 1000;

function isDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();

  for (const [id, ts] of seen.entries()) {
    if (now - ts > DEDUPE_TTL_MS) seen.delete(id);
  }

  if (seen.has(msgId)) return true;
  seen.set(msgId, now);
  return false;
}

// ====== SESSÕES (memória curta + estado) ======
const sessions = new Map();
/**
 * session = {
 *   stage: "FIRST" | "ASKED_HOW" | "ASKED_KNOWS" | "ASKED_SEGMENT" | "CHAT",
 *   history: [{role, content}],
 *   lastAssistant: string,
 *   lastInboundHash: string,
 *   lastInboundAt: number,
 *   updatedAt: number
 * }
 */
const SESSION_TTL_MS = 40 * 60 * 1000;
const MAX_HISTORY = 12;

function cleanupSessions() {
  const now = Date.now();
  for (const [k, s] of sessions.entries()) {
    if (now - (s.updatedAt || 0) > SESSION_TTL_MS) sessions.delete(k);
  }
}
setInterval(cleanupSessions, 60_000).unref();

function getSession(userId) {
  let s = sessions.get(userId);
  if (!s) {
    s = {
      stage: "FIRST",
      history: [],
      lastAssistant: "",
      lastInboundHash: "",
      lastInboundAt: 0,
      updatedAt: Date.now(),
    };
    sessions.set(userId, s);
  }
  s.updatedAt = Date.now();
  return s;
}

function pushHistory(session, role, content) {
  const txt = norm(content);
  if (!txt) return;
  session.history.push({ role, content: txt });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

// ====== DETECTORES ======

// 1) Pergunta sobre identidade (só revela se perguntarem)
function isIdentityQuestion(text = "") {
  const t = lower(text);
  const patterns = [
    "voce e ia",
    "vc e ia",
    "isso e ia",
    "e ia",
    "voce e robo",
    "vc e robo",
    "voce e um bot",
    "vc e bot",
    "chatbot",
    "inteligencia artificial",
    "quem e voce",
    "quem ta falando",
    "quem está falando",
    "voce e humano",
    "vc e humano",
    "e uma pessoa",
    "é uma pessoa",
    "é humano",
    "é real",
  ];
  return patterns.some((p) => t.includes(p));
}

// 2) Detector de pergunta (para aplicar trava somente quando o usuário perguntar)
function isQuestion(text = "") {
  const t = norm(text);
  if (!t) return false;

  if (t.endsWith("?")) return true;

  const x = lower(t);
  const starters = [
    "como",
    "o que",
    "oq",
    "qual",
    "quais",
    "quanto",
    "onde",
    "quando",
    "por que",
    "porque",
    "pra que",
    "para que",
    "me explica",
    "explica",
    "pode",
    "vc pode",
    "voce pode",
    "tem como",
    "da pra",
    "dá pra",
    "é possivel",
    "e possivel",
  ];
  return starters.some((s) => x.startsWith(s));
}

// 3) Escopo permitido (só para bloquear PERGUNTAS fora do assunto)
function isInTriviaScope(text = "") {
  const t = lower(text);

  // Saudações não são “fora do escopo”
  const greetings = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "eai", "e aí", "opa"];
  if (greetings.includes(t)) return true;

  const allowed = [
    // marca / universo
    "trivia",
    "trívia",
    "mel",
    "tecnologia que responde",

    // atendimento / whatsapp
    "atendimento",
    "cliente",
    "clientes",
    "whatsapp",
    "wpp",
    "mensagem",
    "mensagens",
    "responder",
    "resposta",
    "suporte",
    "sac",
    "fila",
    "triagem",
    "humanizado",
    "humano",
    "equipe",
    "encaminhar",

    // módulos
    "agendamento",
    "agenda",
    "pedido",
    "pedidos",
    "orcamento",
    "orçamento",
    "relatorio",
    "relatório",
    "crm",
    "lead",
    "leads",

    // comercial (sem empurrar)
    "planos",
    "plano",
    "preco",
    "preço",
    "valor",
    "mensalidade",
    "contratar",
    "implantar",
    "implantacao",
    "implantação",

    // tech / meta
    "api",
    "meta",
    "cloud",
    "business",
    "webhook",
    "token",
    "nuvem",
    "railway",

    // marketing (somente ligado ao serviço)
    "marketing",
    "instagram",
    "facebook",
    "anuncio",
    "anúncio",
    "direct",
    "dm",
  ];

  return allowed.some((k) => t.includes(k));
}

// ====== RESPOSTAS FIXAS DA MEL (ETAPAS HUMANAS) ======
function melStep1() {
  // ETAPA 1 (FECHADA)
  return "Oi 🙂\nMel aqui.\nComo você tá hoje?";
}

function melAskKnowsTrivia() {
  return "Que bom te ver por aqui.\nVocê já conhecia a TRÍVIA ou é sua primeira vez conversando com a gente?";
}

function melIdentityAnswer() {
  // Só quando perguntarem diretamente
  return (
    "Boa pergunta 🙂\n\n" +
    "Eu sou a Mel — faço parte da TRÍVIA.\n" +
    "Sou uma assistente criada com tecnologia pra conversar de um jeito natural.\n\n" +
    "Mas vamos no que importa: como tá sua rotina com clientes hoje?"
  );
}

function melOutOfScopeRedirect() {
  // Redireciona SEM bronca e SEM parecer robô
  return (
    "Boa 😄\n" +
    "Eu até iria nessa… mas aqui eu fico no universo de atendimento e rotina com clientes.\n\n" +
    "Me diz: seu dia tá mais tranquilo ou mais correria?"
  );
}

// Interpretação simples do “já conhecia?”
function classifyKnowsReply(text = "") {
  const t = lower(text);
  const yes = ["sim", "ja", "já", "conheco", "conheço", "conhecia", "sei", "claro", "ouvi falar", "conheço"];
  const no = ["nao", "não", "primeira vez", "nunca", "nao conheco", "não conheço", "cheguei agora", "to conhecendo"];
  if (yes.some((w) => t.includes(w))) return "YES";
  if (no.some((w) => t.includes(w))) return "NO";
  return "UNKNOWN";
}

// ====== WHATSAPP SEND ======
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

// ====== OPENAI PROMPT (Mel: alterna afirmação + pergunta; sem empurrar produto) ======
const SYSTEM_PROMPT = `
Você é Mel, atendente da TRÍVIA.

PERSONALIDADE (fixa):
- Humana, próxima, inteligente e espirituosa (leve).
- Conversa natural (não entrevistadora). Alterna: afirmação/observação -> uma pergunta leve.
- 0 ou 1 emoji por mensagem (e nem sempre).

REGRAS ABSOLUTAS:
1) NÃO empurre produto no início. Primeiro conexão + entender a pessoa.
2) NÃO fale "script engessado", "funil", termos técnicos na abordagem.
3) Você NÃO oferece planos, preço ou "simulação" de cara. Só depois que entender se a pessoa já conhece a TRÍVIA e o contexto.
4) Você NÃO sugere "fale com um especialista". É PROIBIDO. Você mesma conduz com clareza e calma.
5) Você SÓ revela que é tecnologia/IA se o usuário perguntar diretamente "você é IA/robô?".
6) Escopo: só fale de TRÍVIA e assuntos ligados a atendimento, WhatsApp, automação, triagem, módulos (agendamento, pedidos/orçamentos, relatórios), integrações e marketing no contexto do serviço.
7) Se o usuário fizer pergunta fora do escopo, recuse com elegância e redirecione para atendimento (sem bronca, sem aula).
8) No máximo 1 pergunta por mensagem.
9) Respostas curtas: 2 a 6 linhas.

OBJETIVO:
- Criar conversa gostosa e humana.
- Descobrir, com suavidade: se a pessoa já conhece a TRÍVIA, qual segmento e como é a rotina de atendimento.
- Só depois conectar isso ao valor da TRÍVIA.
`.trim();

async function generateAI(session, userText) {
  if (!openai) {
    return "Entendi 🙂\n\nMe conta só um detalhe: você atende clientes mais por WhatsApp, Instagram… ou os dois?";
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...session.history.slice(-MAX_HISTORY),
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
  if (!out) out = "Tô aqui 🙂 Como você tá hoje, de verdade?";

  return out;
}

// Anti repetição simples
function tooSimilar(a, b) {
  const na = lower(a).replace(/\s+/g, " ");
  const nb = lower(b).replace(/\s+/g, " ");
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minLen = Math.min(na.length, nb.length);
  if (minLen < 25) return false;
  let i = 0;
  while (i < minLen && na[i] === nb[i]) i++;
  return i / minLen > 0.85;
}

// ===== WEBHOOK VERIFY (GET) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== HEALTH =====
app.get("/", (_req, res) => res.status(200).send("TRÍVIA (Mel) online ✅"));

// ===== WEBHOOK RECEIVE (POST) =====
app.post("/webhook", (req, res) => {
  // responde rápido pra Meta
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;

      // ignora status (delivered/read)
      if (value?.statuses) return;

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const msgId = msg.id;

      if (!from || !msgId) return;
      if (isDuplicate(msgId)) return;

      // só texto por enquanto
      if (msg.type !== "text") {
        const session = getSession(from);
        const reply =
          "Recebi 🙂\n" +
          "Por enquanto eu entendo melhor mensagens em texto.\n\n" +
          "Como você tá hoje?";
        if (!tooSimilar(reply, session.lastAssistant)) {
          await sendWhatsAppText(from, reply);
          session.lastAssistant = reply;
          pushHistory(session, "assistant", reply);
          session.stage = session.stage === "FIRST" ? "ASKED_HOW" : session.stage;
        }
        return;
      }

      const userText = norm(msg.text?.body || "");
      if (!userText) return;

      const session = getSession(from);

      // Dedup de conteúdo muito rápido (evita eco)
      const inboundHash = sha1(userText);
      const now = Date.now();
      if (inboundHash === session.lastInboundHash && now - session.lastInboundAt < 2500) return;
      session.lastInboundHash = inboundHash;
      session.lastInboundAt = now;

      // guarda no histórico
      pushHistory(session, "user", userText);

      // 1) Se perguntar identidade => revela (somente aqui)
      if (isIdentityQuestion(userText)) {
        const reply = melIdentityAnswer();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.stage = "CHAT";
        return;
      }

      // 2) TRAVA: só aplica quando o usuário FAZ UMA PERGUNTA fora do escopo
      if (isQuestion(userText) && !isInTriviaScope(userText)) {
        const reply = melOutOfScopeRedirect();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        return;
      }

      // 3) FLUXO HUMANO (Etapas) — sem empurrar produto

      // FIRST: envia ETAPA 1
      if (session.stage === "FIRST") {
        const reply = melStep1();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.stage = "ASKED_HOW";
        return;
      }

      // ASKED_HOW: usuário respondeu "como tá" (qualquer resposta é válida)
      if (session.stage === "ASKED_HOW") {
        const reply = melAskKnowsTrivia();
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.stage = "ASKED_KNOWS";
        return;
      }

      // ASKED_KNOWS: interpreta se conhece ou não
      if (session.stage === "ASKED_KNOWS") {
        const k = classifyKnowsReply(userText);

        if (k === "NO") {
          // Explica simples (sem vender) + pergunta leve (uma só)
          const reply =
            "Perfeito 🙂\n" +
            "A TRÍVIA existe pra deixar o atendimento com clientes mais leve e organizado — principalmente no WhatsApp.\n\n" +
            "Me conta: você trabalha com que tipo de negócio?";
          await sendWhatsAppText(from, reply);
          session.lastAssistant = reply;
          pushHistory(session, "assistant", reply);
          session.stage = "ASKED_SEGMENT";
          return;
        }

        if (k === "YES") {
          const reply =
            "Ah, que legal 🙂\n" +
            "E o que mais te chamou atenção quando você ouviu falar da TRÍVIA?";
          await sendWhatsAppText(from, reply);
          session.lastAssistant = reply;
          pushHistory(session, "assistant", reply);
          // Depois disso, já entra no chat com IA (porque a pessoa vai explicar)
          session.stage = "CHAT";
          return;
        }

        // UNKNOWN
        const reply =
          "Entendi 🙂\n" +
          "Só pra eu me situar direitinho:\n" +
          "você já conhecia a TRÍVIA ou tá descobrindo agora?";
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        return;
      }

      // ASKED_SEGMENT: usuário falou segmento -> responde com empatia + 1 pergunta leve (não comercial)
      if (session.stage === "ASKED_SEGMENT") {
        const reply =
          "Entendi 🙂\n" +
          "Esse tipo de negócio costuma ter bastante troca de mensagem no dia a dia.\n\n" +
          "Hoje, o que pesa mais pra você: *volume* de mensagens ou *organização* das respostas?";
        await sendWhatsAppText(from, reply);
        session.lastAssistant = reply;
        pushHistory(session, "assistant", reply);
        session.stage = "CHAT";
        return;
      }

      // 4) CHAT: agora sim entra a IA (mas com prompt que evita empurrar produto)
      const aiReply = await generateAI(session, userText);

      // Anti-loop
      let finalReply = aiReply;
      if (tooSimilar(finalReply, session.lastAssistant)) {
        finalReply =
          "Te entendi 🙂\n\n" +
          "Me ajuda com um detalhe só: hoje sua rotina com clientes te cansa mais por *responder rápido* ou por *manter tudo organizado*?";
      }

      await sendWhatsAppText(from, finalReply);
      session.lastAssistant = finalReply;
      pushHistory(session, "assistant", finalReply);
    } catch (err) {
      console.error("❌ Webhook error:", err?.response?.data || err?.message || err);
    }
  });
});

// ===== START =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TRÍVIA (Mel) rodando na porta ${PORT}`);
});
