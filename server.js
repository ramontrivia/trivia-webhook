"use strict";

/**
 * TRÍVIA - Webhook WhatsApp + OpenAI (Mel)
 * - Express webhook (GET verify + POST)
 * - Dedup de mensagens (WhatsApp reenviando webhook)
 * - Sessão por usuário (histórico curto)
 * - Escopo: só trava quando o usuário FAZ PERGUNTA fora do tema
 * - Transferência pro comercial (manda alerta pro seu WhatsApp)
 * - Logs curtos (evita explodir Railway)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

// =========================
// ENV (Railway Variables)
// =========================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "trivia123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Meta token (Cloud API)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Meta phone_number_id
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").replace(/\D/g, ""); // ex: 5531999646223
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Porta
const PORT = process.env.PORT || 8080;

// =========================
// Validadores básicos
// =========================
function requireEnv(name, value) {
  if (!value || String(value).trim() === "") {
    throw new Error(`Faltando variável de ambiente: ${name}`);
  }
}
requireEnv("WHATSAPP_TOKEN", WHATSAPP_TOKEN);
requireEnv("PHONE_NUMBER_ID", PHONE_NUMBER_ID);
requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);

// =========================
// App
// =========================
const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// =========================
// Base de conhecimento (TXT)
// =========================
function loadKnowledge() {
  try {
    const p = path.join(__dirname, "knowledge", "trivia_base.txt");
    if (!fs.existsSync(p)) return "";
    const content = fs.readFileSync(p, "utf8");
    // Evita estourar tokens: limita a ~35k chars (ajuste se quiser)
    return content.slice(0, 35000);
  } catch (e) {
    return "";
  }
}

const KNOWLEDGE = loadKnowledge();
console.log(`[boot] Base carregada: ${KNOWLEDGE ? "sim" : "não"}`);

// =========================
// Utilidades de texto
// =========================
function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function isQuestion(text) {
  const t = norm(text);
  if (!t) return false;
  if (text.includes("?")) return true;
  // padrões comuns de pergunta
  const starters = [
    "como",
    "qual",
    "quais",
    "quanto",
    "onde",
    "quando",
    "por que",
    "porque",
    "pra que",
    "para que",
    "tem",
    "voce tem",
    "voces tem",
    "da pra",
    "da para",
    "pode",
    "consegue",
    "funciona",
    "faz",
    "fazem",
    "o que",
    "oq",
    "quem",
  ];
  return starters.some((x) => t.startsWith(x + " ") || t === x);
}

function wantsCommercial(text) {
  const t = norm(text);
  const keys = [
    "contratar",
    "assinar",
    "comprar",
    "comercial",
    "vendedor",
    "vendas",
    "quero fechar",
    "quero contratar",
    "preco",
    "valor",
    "custo",
    "quanto custa",
    "proposta",
    "orcamento",
    "orçamento",
    "falar com humano",
    "falar com atendente",
    "transferir",
    "passa contato",
    "telefone",
    "whatsapp de voces",
    "whatsapp de vocês",
  ];
  return keys.some((k) => t.includes(norm(k)));
}

function isGreetingOrShortReply(text) {
  const t = norm(text);
  if (!t) return false;
  if (t.length <= 14) return true; // "ok", "sim", "boa tarde"
  const greet = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "tudo bem", "td bem", "blz", "beleza"];
  return greet.some((g) => t === norm(g) || t.startsWith(norm(g) + " "));
}

function inTriviaScope(text) {
  // Escopo: tecnologia de atendimento, WhatsApp, automação, triagem, relatórios, integrações, marketing digital etc.
  const t = norm(text);
  const allow = [
    "trivia",
    "trivia",
    "mel",
    "atendimento",
    "cliente",
    "whatsapp",
    "wpp",
    "api",
    "meta",
    "cloud api",
    "automacao",
    "automação",
    "bot",
    "chatbot",
    "triagem",
    "fila",
    "sac",
    "suporte",
    "agendamento",
    "agenda",
    "pedido",
    "pedidos",
    "orcamento",
    "orçamento",
    "relatorio",
    "relatório",
    "modulo",
    "módulo",
    "plano",
    "planos",
    "preco",
    "preço",
    "valor",
    "mensalidade",
    "contrato",
    "implantacao",
    "implantação",
    "integracao",
    "integração",
    "crm",
    "leads",
    "instagram",
    "facebook",
    "marketing",
    "redes sociais",
    "anuncio",
    "anúncio",
    "funil",
    "captacao",
    "captação",
    "mensagens",
    "atender",
    "responder",
    "roteamento",
    "transferir",
    "humano",
    "atendente",
    "comercial",
    "vendas",
    "fluxo",
    "rotina",
    "atraso",
    "tempo de resposta",
    "perder cliente",
    "perder clientes",
  ];

  // “sim / ok / obrigado / estou bem” não deve travar nunca
  if (isGreetingOrShortReply(text)) return true;

  // Se o texto tem pelo menos um termo do universo, considera dentro
  return allow.some((k) => t.includes(norm(k)));
}

// =========================
// Memória + Dedup (em memória)
// =========================
const sessions = new Map(); // from -> { messages: [{role, content}], lastSeen }
const seenMessageIds = new Map(); // msgId -> timestamp

const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const DEDUP_TTL_MS = 1000 * 60 * 30; // 30 min
const MAX_HISTORY = 14;

function cleanupMaps() {
  const now = Date.now();

  for (const [k, v] of sessions.entries()) {
    if (!v || !v.lastSeen || now - v.lastSeen > SESSION_TTL_MS) sessions.delete(k);
  }
  for (const [id, ts] of seenMessageIds.entries()) {
    if (!ts || now - ts > DEDUP_TTL_MS) seenMessageIds.delete(id);
  }
}
setInterval(cleanupMaps, 60 * 1000).unref();

function getSession(from) {
  const now = Date.now();
  let s = sessions.get(from);
  if (!s) {
    s = { messages: [], lastSeen: now, greeted: false };
    sessions.set(from, s);
  }
  s.lastSeen = now;
  return s;
}

// =========================
// WhatsApp Cloud API
// =========================
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
    return true;
  } catch (err) {
    // LOG CURTO (não explode Railway)
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log(`[wa_send_error] status=${status || "?"} msg=${err?.message || "?"}`);
    if (status && data) console.log(`[wa_send_error_data] ${JSON.stringify(data).slice(0, 500)}`);
    return false;
  }
}

async function notifyCommercial(from, userText, aiAnswer) {
  if (!COMMERCIAL_PHONE) return false;

  const msg =
    `🔔 *TRÍVIA - Lead pedindo comercial*\n\n` +
    `📱 Cliente: ${from}\n` +
    `💬 Mensagem: ${userText}\n\n` +
    `🧠 Última resposta (Mel): ${aiAnswer}\n\n` +
    `👉 Sugestão: responder e oferecer uma call curta + proposta.`;

  return await sendWhatsAppText(COMMERCIAL_PHONE, msg);
}

// =========================
// Persona / Prompt
// =========================
function systemPrompt() {
  const base =
    `Você é a *Mel*, atendente da TRÍVIA.\n\n` +
    `Tom:\n` +
    `- Natural, leve, humana, educada.\n` +
    `- Um toque de humor sutil, poucos emojis.\n` +
    `- Sem empurrar planos no começo. Primeiro cria conexão.\n\n` +
    `Regras essenciais:\n` +
    `1) Você NÃO sai do assunto TRÍVIA/atendimento/WhatsApp/automação/rotina de atendimento/marketing digital.\n` +
    `2) Se o usuário fizer uma PERGUNTA fora desse tema, responda com educação e traga de volta para TRÍVIA.\n` +
    `3) Se o usuário só estiver respondendo algo (ex: "estou bem"), você continua fluindo naturalmente.\n` +
    `4) Você só revela que é IA se perguntarem diretamente.\n` +
    `5) Você sempre tenta entender o contexto com perguntas suaves e curtas.\n\n` +
    `Objetivo da conversa:\n` +
    `- Fazer uma experiência boa e fluida.\n` +
    `- Entender o cenário do cliente.\n` +
    `- Quando perceber interesse de contratação, orientar para falar com o comercial.\n\n`;

  const kb = KNOWLEDGE
    ? `Base de conhecimento da TRÍVIA (use como fonte):\n---\n${KNOWLEDGE}\n---\n`
    : "";

  return base + kb;
}

function firstMessage() {
  // Versão 2 ajustada: leve, empática, sem “script engessado”
  return (
    `Oi 😊 aqui é a *Mel*, da TRÍVIA — *tecnologia que responde*.\n\n` +
    `Como você tá hoje?`
  );
}

function outOfScopeReply() {
  return (
    `Boa 🙂 eu entendi sua pergunta.\n\n` +
    `Aqui eu fico no universo de *atendimento, WhatsApp e automação* (TRÍVIA). ` +
    `Se você me disser rapidinho *o que você quer melhorar no seu atendimento*, eu te ajudo de verdade.`
  );
}

// =========================
// OpenAI - gerar resposta
// =========================
async function generateReply(from, userText) {
  const session = getSession(from);

  // Primeira mensagem (quando a pessoa só manda “oi” etc.)
  if (!session.greeted) {
    session.greeted = true;
    session.messages.push({ role: "assistant", content: firstMessage() });
    return firstMessage();
  }

  // Trava de escopo: SOMENTE se for PERGUNTA e fora do escopo
  if (isQuestion(userText) && !inTriviaScope(userText)) {
    const msg = outOfScopeReply();
    session.messages.push({ role: "assistant", content: msg });
    return msg;
  }

  // Monta mensagens com memória
  const messages = [
    { role: "system", content: systemPrompt() },
    ...session.messages.slice(-MAX_HISTORY),
    { role: "user", content: userText },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 260,
    });

    const answer = resp?.choices?.[0]?.message?.content?.trim() || "Entendi. Me conta um pouco mais?";
    // salva histórico
    session.messages.push({ role: "user", content: userText });
    session.messages.push({ role: "assistant", content: answer });

    return answer;
  } catch (err) {
    // LOG CURTO (sem objeto gigante)
    const status = err?.status || err?.response?.status;
    const msg = err?.message || "erro";
    console.log(`[openai_error] status=${status || "?"} msg=${msg}`);

    // fallback amigável
    return (
      `Putz 😅 eu dei uma engasgada aqui por um instante.\n` +
      `Você pode repetir em 1 frase o que você quer resolver no seu atendimento?`
    );
  }
}

// =========================
// Webhook Verify (GET)
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =========================
// Webhook Messages (POST)
// =========================
app.post("/webhook", async (req, res) => {
  // Responde rápido pro Meta (evita retries)
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from; // telefone do usuário (ex: 5531...)
    const msgId = msg.id;

    // Dedup
    if (msgId) {
      if (seenMessageIds.has(msgId)) return;
      seenMessageIds.set(msgId, Date.now());
    }

    // Ignora tipos não-texto (por enquanto)
    const type = msg.type;
    let userText = "";

    if (type === "text") userText = msg?.text?.body || "";
    else {
      // Se quiser depois, aqui entra áudio/imagem/documento
      await sendWhatsAppText(from, "Recebi sua mensagem 🙂 por enquanto eu entendo melhor *texto*. Pode me mandar em texto?");
      return;
    }

    userText = (userText || "").trim();
    if (!userText) return;

    // Gatilho comercial
    // (o “pedido de comercial” deve funcionar mesmo se o texto for curto)
    let answer = await generateReply(from, userText);

    // Se pediu comercial/contratar → avisa comercial e responde ao cliente com CTA profissional
    if (wantsCommercial(userText)) {
      const ok = await notifyCommercial(from, userText, answer);

      // Resposta final ao cliente (melhor que “procure site oficial”)
      const final =
        `Perfeito. Se você quiser, eu *te coloco com o comercial agora*.\n` +
        `Só me diz: qual é o *nome da sua empresa* e qual cidade/estado?`;

      await sendWhatsAppText(from, final);

      // Se não conseguiu avisar comercial, pelo menos loga curto
      if (!ok) console.log("[commercial_notify] falhou (provável janela/permite template)");
      return;
    }

    // Resposta normal
    await sendWhatsAppText(from, answer);
  } catch (e) {
    // LOG CURTO
    console.log(`[webhook_error] ${e?.message || e}`);
  }
});

// Health
app.get("/", (req, res) => res.status(200).send("TRÍVIA OK"));

app.listen(PORT, () => {
  console.log(`[boot] Servidor rodando na porta ${PORT}`);
});
