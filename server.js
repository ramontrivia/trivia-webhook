"use strict";

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * RAILWAY VARIABLES (obrigatórias)
 * VERIFY_TOKEN
 * WHATSAPP_TOKEN
 * PHONE_NUMBER_ID
 * OPENAI_API_KEY
 *
 * (opcionais)
 * OPENAI_MODEL (default: gpt-4o-mini)
 * WHATSAPP_API_VERSION (default: v20.0)
 * SESSION_TTL_MINUTES (default: 45)
 */

const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const GRAPH_VERSION = (process.env.WHATSAPP_API_VERSION || "v20.0").trim();
const SESSION_TTL_MS =
  Number(process.env.SESSION_TTL_MINUTES || 45) * 60 * 1000;

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.warn(
    "⚠️ Faltam variáveis. Confira: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * =========================
 * DEDUPE (Meta pode reenviar o mesmo evento)
 * =========================
 */
const processedMessageIds = new Map();
const DEDUPE_TTL_MS = 30 * 60 * 1000; // 30 min

function markDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();

  // cleanup
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.set(msgId, now);
  return false;
}

/**
 * =========================
 * SESSIONS (memória + etapa da jornada)
 * =========================
 * Em produção ideal: Redis/DB. Aqui é RAM (MVP).
 */
const sessions = new Map();
// from -> { stage, businessName, history[], updatedAt }

const MAX_HISTORY_MESSAGES = 18; // mensagens (não turnos) para não crescer infinito

function getSession(from) {
  const now = Date.now();

  // cleanup sessões
  for (const [k, s] of sessions.entries()) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }

  if (!sessions.has(from)) {
    sessions.set(from, {
      stage: "INTRO", // INTRO -> PAIN -> SIM_NAME -> SIM_DEMO -> CLOSE
      businessName: null,
      history: [],
      updatedAt: now,
    });
  }

  const s = sessions.get(from);
  s.updatedAt = now;
  return s;
}

function pushHistory(from, role, content) {
  const s = getSession(from);
  if (!content || !String(content).trim()) return;

  s.history.push({ role, content: String(content).trim() });

  // limita histórico
  if (s.history.length > MAX_HISTORY_MESSAGES) {
    s.history = s.history.slice(-MAX_HISTORY_MESSAGES);
  }

  s.updatedAt = Date.now();
}

function normalizeText(t) {
  return (t || "").toString().trim();
}

function lower(t) {
  return normalizeText(t).toLowerCase();
}

/**
 * =========================
 * WHATSAPP SEND TEXT
 * =========================
 */
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const headers = {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  await axios.post(url, payload, { headers, timeout: 15000 });
}

/**
 * =========================
 * A JORNADA (copy pronta)
 * =========================
 * Aberturas + transições, mas sem engessar.
 * A IA preenche o resto com naturalidade.
 */
function scriptedIntro() {
  // fora da curva, leve, empática, sem agressividade
  return (
    "Chegou rápido, né? 🙂\n\n" +
    "É exatamente esse o ponto.\n" +
    "Quando o atendimento responde no tempo certo, cliente não some.\n\n" +
    "Me conta: o que mais está te cansando hoje no seu WhatsApp?"
  );
}

function scriptedAskPainFollowup(userText) {
  // resposta humana “acolhe” antes de ir pro próximo passo
  return (
    "Entendi.\n\n" +
    "Isso é mais comum do que parece — e dá pra organizar sem virar um caos.\n\n" +
    "Quer que eu te mostre na prática, com uma simulação rápida do seu atendimento?"
  );
}

function scriptedAskBusinessName() {
  return (
    "Boa. Então vamos fazer do jeito mais claro:\n\n" +
    "Me diga o *nome da sua empresa* (do jeitinho que você colocaria no WhatsApp)."
  );
}

function scriptedDemo(businessName) {
  // demo curtinha, sem “simulação iniciada” robótico
  return (
    `Perfeito. Vamos simular aqui rapidinho.\n\n` +
    `📍 *${businessName}*\n` +
    `Cliente: "Oi! Vocês conseguem me atender agora?"\n` +
    `Atendimento: "Consigo sim 🙂 Me diz só: você quer *informação*, *agendar* ou *fazer um pedido*?"\n\n` +
    `Viu? É simples, rápido e não deixa ninguém no vácuo.\n\n` +
    `Quer que eu te indique o melhor caminho (plano) pro seu cenário?`
  );
}

function scriptedClose() {
  return (
    "Fechado.\n\n" +
    "A TRÍVIA funciona assim (bem direto):\n" +
    "• *BASIC* — respostas + triagem\n" +
    "• *PLUS* — BASIC + agendamento\n" +
    "• *MASTER* — PLUS + pedidos/orçamentos\n" +
    "• *ULTRA* — operação completa + camada estratégica\n\n" +
    "Pra eu te indicar certinho sem chute: quantas mensagens você recebe por dia, mais ou menos?"
  );
}

/**
 * =========================
 * PROMPT (IA) — segura, humana, criativa, sem inventar
 * =========================
 */
function buildSystemPrompt(session) {
  return `
Você é a TRÍVIA (tecnologia que responde).
Você escreve como um humano: natural, leve, inteligente, com humor discreto quando couber.
Você NÃO revela que é IA, a menos que a pessoa pergunte.

REGRAS DURAS (obrigatórias):
- Nunca invente dados (segmento, volume, nome, etc.).
- Nunca “preencha formulário” com suposição.
- Se algo não foi dito, você pergunta.
- Não recomece conversa com "Olá, como posso ajudar?".
- Não repita perguntas já respondidas.
- Mensagens curtas (WhatsApp), com ritmo natural.
- No máximo 1 emoji quando fizer sentido.

OBJETIVO DA CONVERSA:
Criar uma experiência fora do padrão, mostrar valor (velocidade + organização),
fazer uma mini simulação e conduzir para aquisição (sem pressão).

CONTEXTO DE ESTADO (STAGE):
O estado atual é: ${session.stage}
- INTRO: a pessoa acabou de entrar, queremos quebrar padrão e chegar na dor.
- PAIN: entender a dor e pedir permissão para simular.
- SIM_NAME: pedir nome da empresa.
- SIM_DEMO: entregar demo curta (sem parecer robô).
- CLOSE: conduzir para proposta e próximo passo.

IMPORTANTE:
Quando o usuário for curto ("sim", "ok"), você continua de onde está,
sem resetar e sem mudar assunto.
`.trim();
}

/**
 * =========================
 * IA: responde com histórico + estado
 * =========================
 */
async function aiReply(from, userText) {
  const session = getSession(from);

  const system = buildSystemPrompt(session);

  // histórico recente
  const history = session.history.slice(-MAX_HISTORY_MESSAGES);

  const messages = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userText },
  ];

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.55,
    max_tokens: 260,
    messages,
  });

  const out = resp?.choices?.[0]?.message?.content?.trim();
  return out || "Entendi. Me diz só mais um detalhe pra eu te orientar melhor.";
}

/**
 * =========================
 * ORQUESTRADOR DA JORNADA
 * =========================
 * Aqui está a “dinâmica completa”:
 * - O código controla apenas a ETAPA.
 * - A IA cuida do improviso com base no estado e histórico.
 */
async function orchestrateAndRespond(from, userTextRaw) {
  const session = getSession(from);
  const userText = normalizeText(userTextRaw);
  const t = lower(userText);

  // comandos úteis (opcional)
  if (t === "reset" || t === "reiniciar") {
    sessions.delete(from);
    await sendWhatsAppText(from, "Beleza. Vamos do zero 🙂\n\nMe diz: o que está pesando no seu atendimento hoje?");
    return;
  }

  // guarda mensagem do usuário
  pushHistory(from, "user", userText);

  // STAGE HANDLING
  if (session.stage === "INTRO") {
    // Se a pessoa mandou só “oi”, “bom dia”, etc., não faz IA ainda: manda a abertura forte.
    // Se ela já veio com uma dor (“demora”, “não consigo responder”), podemos pular pro PAIN via IA.
    const greetings = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "eai", "e aí"];
    const looksLikeGreeting = greetings.includes(t) || t.length <= 3;

    if (looksLikeGreeting) {
      const msg = scriptedIntro();
      pushHistory(from, "assistant", msg);
      session.stage = "PAIN";
      await sendWhatsAppText(from, msg);
      return;
    }

    // se já veio com problema, responde humano e já pede permissão p/ simular (IA)
    session.stage = "PAIN";
    const reply = await aiReply(from, userText);
    pushHistory(from, "assistant", reply);
    await sendWhatsAppText(from, reply);
    return;
  }

  if (session.stage === "PAIN") {
    // Queremos: acolher + pedir permissão para simular
    // Se usuário já disse “quero simular”/“mostra” -> vai direto pro nome
    if (t.includes("sim") && (t.includes("mostra") || t.includes("simula") || t.includes("quero") || t.includes("pode"))) {
      const msg = scriptedAskBusinessName();
      pushHistory(from, "assistant", msg);
      session.stage = "SIM_NAME";
      await sendWhatsAppText(from, msg);
      return;
    }

    // Caso geral: uma resposta curta empática + pergunta “quer simulação?”
    const msg = scriptedAskPainFollowup(userText);
    pushHistory(from, "assistant", msg);
    // Não muda stage ainda; só muda quando ele aceitar a simulação
    await sendWhatsAppText(from, msg);
    return;
  }

  if (session.stage === "SIM_NAME") {
    // aqui queremos capturar o nome da empresa
    // se vier muito curto tipo “sim”, pede nome novamente sem ficar robótico
    if (t === "sim" || t === "ok" || t === "certo") {
      const msg = "Fechado 🙂\n\nMe diga só o nome da sua empresa (como aparece para o cliente).";
      pushHistory(from, "assistant", msg);
      await sendWhatsAppText(from, msg);
      return;
    }

    // assume que o usuário escreveu o nome da empresa
    session.businessName = userText;
    const msg = scriptedDemo(session.businessName);
    pushHistory(from, "assistant", msg);
    session.stage = "SIM_DEMO";
    await sendWhatsAppText(from, msg);
    return;
  }

  if (session.stage === "SIM_DEMO") {
    // se ele disser “sim” ou pedir plano, vai pro fechamento
    if (t.includes("sim") || t.includes("plano") || t.includes("valor") || t.includes("preço") || t.includes("quero")) {
      const msg = scriptedClose();
      pushHistory(from, "assistant", msg);
      session.stage = "CLOSE";
      await sendWhatsAppText(from, msg);
      return;
    }

    // se ele fizer pergunta aqui, usa IA (mantendo stage)
    const reply = await aiReply(from, userText);
    pushHistory(from, "assistant", reply);
    await sendWhatsAppText(from, reply);
    return;
  }

  if (session.stage === "CLOSE") {
    // aqui você pode coletar 1 dado (volume) e conduzir para contato comercial.
    // Se ele respondeu um número, a IA pode conduzir para proposta.
    // Se não, IA conduz para clarificar.

    const reply = await aiReply(from, userText);
    pushHistory(from, "assistant", reply);
    await sendWhatsAppText(from, reply);
    return;
  }

  // fallback: IA
  const reply = await aiReply(from, userText);
  pushHistory(from, "assistant", reply);
  await sendWhatsAppText(from, reply);
}

/**
 * =========================
 * ROUTES
 * =========================
 */
app.get("/", (_req, res) => res.status(200).send("TRÍVIA online ✅"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  // responde rápido para Meta
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const body = req.body;

      if (!body?.entry?.length) return;
      const value = body.entry?.[0]?.changes?.[0]?.value;

      // ignora status (delivered/read)
      if (value?.statuses) return;

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const msgId = msg.id;
      const type = msg.type;

      if (!from || !msgId) return;

      // dedupe
      if (markDuplicate(msgId)) return;

      // neste MVP vamos suportar texto
      let userText = "";
      if (type === "text") {
        userText = msg?.text?.body || "";
      } else {
        await sendWhatsAppText(from, "Por enquanto eu atendo melhor por texto 🙂 Pode me mandar sua mensagem por escrito?");
        return;
      }

      userText = normalizeText(userText);
      if (!userText) return;

      await orchestrateAndRespond(from, userText);
    } catch (err) {
      console.error("❌ Webhook error:", err?.response?.data || err?.message || err);
    }
  });
});

/**
 * =========================
 * START
 * =========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Rodando na porta", PORT));
