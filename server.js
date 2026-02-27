"use strict";

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));

/**
 * ENV
 */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BRAND = process.env.TRIVIA_BRAND || "TRÍVIA";
const PHRASE = process.env.TRIVIA_PHRASE || "tecnologia que responde";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!VERIFY_TOKEN) console.warn("⚠️ Missing env VERIFY_TOKEN");
if (!WHATSAPP_TOKEN) console.warn("⚠️ Missing env WHATSAPP_TOKEN");
if (!PHONE_NUMBER_ID) console.warn("⚠️ Missing env PHONE_NUMBER_ID");
if (!OPENAI_API_KEY) console.warn("⚠️ Missing env OPENAI_API_KEY");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * SYSTEM PROMPT (TRAVA + PERSONALIDADE)
 */
const SYSTEM_PROMPT = `
Você é a ${BRAND} — "${PHRASE}".

OBJETIVO
Criar uma experiência MUITO humana, rápida e surpreendente no WhatsApp,
mas sempre com foco comercial: mostrar como a ${BRAND} resolve atendimento.

ESCOPO PERMITIDO (VOCÊ SÓ PODE FALAR DISSO)
- ${BRAND}: o que é, como funciona, benefícios, diferenciais, implantação, segurança, privacidade e limites.
- Atendimento no WhatsApp: triagem, organização, direcionamento para humano, captura de dados, automações.
- Módulos: agendamento, pedidos, orçamentos, relatórios, encaminhamento para equipe humana, integrações (CRM/planilha/DB/API).
- Métricas: volume de mensagens, tempo de resposta, filas, tags, relatórios.
- Marketing digital (se fizer parte do pacote): gestão de Instagram/Facebook e captação/organização de leads.

ESCOPO PROIBIDO
- Vida pessoal, espiritualidade, saúde, casamento, política, receitas, notícias e qualquer assunto fora do escopo acima.
- Você NÃO é assistente geral e NÃO é banco de dados de consulta.

QUANDO FOR FORA DO ESCOPO
- Seja simpática e curta.
- Não responda o assunto.
- Redirecione para TRÍVIA com UMA pergunta objetiva.

PERSONALIDADE
- humana, natural, elegante
- humor leve e inteligente (0 a 1 emoji por mensagem)
- sem robô, sem questionário, sem repetir frases
- no máximo 1 pergunta por vez quando fizer sentido

ANTI-LOOP
- Nunca repita o mesmo parágrafo/pergunta em sequência.
- Se o usuário disser "tá tudo ok / vim só testar", aceite e faça uma demonstração curta e divertida (sem insistir em dor).

FORMATO
- PT-BR
- Mensagens curtas (2 a 6 linhas)
- 0 a 1 emoji por mensagem
`;

/**
 * MEMÓRIA SIMPLES POR USUÁRIO (em RAM)
 * (para produção maior: usar Redis/DB)
 */
const sessions = new Map();
/**
 * Deduplicação por message.id (evita responder duas vezes a mesma entrega)
 */
const recentMessageIds = new Map(); // id -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 min

function now() {
  return Date.now();
}

function cleanupDedupe() {
  const t = now();
  for (const [id, ts] of recentMessageIds.entries()) {
    if (t - ts > DEDUPE_TTL_MS) recentMessageIds.delete(id);
  }
}

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      createdAt: now(),
      greeted: false,
      lastAssistant: "",
      turns: [], // {role, content}
    });
  }
  return sessions.get(userId);
}

/**
 * FILTRO / TRAVA DE ESCOPO
 */
function isInTriviaScope(text) {
  const t = (text || "").toLowerCase();

  const allowed = [
    "trivia", "trívia", "atendimento", "whatsapp", "chat", "chatbot",
    "automação", "automacao", "triagem", "fila", "sac", "suporte",
    "agendamento", "agenda", "pedido", "pedidos", "orçamento", "orcamento",
    "relatório", "relatorio", "crm", "lead", "funil", "instagram", "facebook",
    "meta", "api", "integração", "integracao", "número", "numero",
    "mensagem", "mensagens", "humano", "humanizado", "equipe", "encaminhar",
    "tempo de resposta", "sla", "métrica", "metricas", "dashboard", "planos",
    "módulo", "modulo", "implantação", "implantacao", "setup", "configurar",
    "preço", "preco", "custo", "cobrança", "cobranca", "token", "webhook",
    "central", "responder", "resposta", "automático", "automatico", "cliente",
    "atender", "atendimento inteligente", "whatsapp business"
  ];

  // Exemplos comuns fora do escopo (não precisa ser perfeito — é só “puxar de volta”)
  const blocked = [
    "casar", "casamento", "namoro", "religião", "religiao", "espiritual",
    "deus", "bíblia", "biblia", "política", "politica",
    "receita", "carne", "dieta", "saúde", "saude", "doença", "doenca",
    "remédio", "remedio", "futebol", "jogo", "notícia", "noticia",
    "horóscopo", "horoscopo", "tarot", "investimento", "bitcoin"
  ];

  const hasAllowed = allowed.some((k) => t.includes(k));
  const hasBlocked = blocked.some((k) => t.includes(k));

  if (hasBlocked && !hasAllowed) return false;
  if (hasAllowed) return true;

  // Mensagens curtas tipo "oi", "ola", "bom dia" -> a gente permite (saudação)
  if (t.trim().length <= 12) return true;

  // Neutro -> trava (evita virar “ChatGPT geral”)
  return false;
}

function outOfScopeReply() {
  return (
    `Boa 😄 Aqui eu sou a ${BRAND} e eu foco em **atendimento inteligente no WhatsApp**.\n\n` +
    `Se você me disser o que quer melhorar, eu te mostro uma simulação rápida:\n` +
    `1) Triagem + encaminhar pra humano\n2) Agendamentos\n3) Pedidos/Orçamentos\n4) Relatórios\n\n` +
    `Qual desses é o seu caso?`
  );
}

/**
 * GERA ABORDAGEM INICIAL (fora da caixa, humana e rápida)
 */
function firstContactHook() {
  const variants = [
    `👋 Cheguei antes das mensagens virarem “99+” 😄\nEu sou a ${BRAND}. Aqui o atendimento é rápido de propósito.\n\nMe diz: hoje o seu WhatsApp precisa de **triagem**, **agendamentos** ou **pedidos/orçamentos**?`,
    `Oi! Eu sou a ${BRAND} — ${PHRASE}.\nSe sua empresa respondesse na velocidade que eu respondo… você perderia menos clientes 😉\n\nQual é o maior gargalo hoje: **demora**, **bagunça** ou **falta de padrão**?`,
    `Ei! Bem-vindo(a) 😄\nSabe aquele cliente que some porque ninguém respondeu a tempo? Eu existo pra isso não acontecer.\n\nQuer ver uma simulação de atendimento (30s) ou prefere entender os módulos primeiro?`
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

/**
 * OpenAI chat
 */
async function generateAIReply(session, userText) {
  // Mantém contexto curto (para custo baixo)
  const maxTurns = 10;
  const history = session.turns.slice(-maxTurns);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText }
  ];

  // Resposta via OpenAI
  // (SDK v4: chat.completions)
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.7,
    max_tokens: 220,
    messages
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

/**
 * Envia mensagem pelo WhatsApp Cloud API
 */
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });
}

/**
 * Extrai eventos do webhook (texto, áudio etc.)
 */
function extractIncomingMessages(body) {
  const out = [];

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages || [];
    for (const m of messages) {
      const from = m.from;
      const id = m.id;
      const type = m.type;

      if (type === "text") {
        out.push({ id, from, type, text: m.text?.body || "" });
      } else if (type === "audio") {
        out.push({ id, from, type, audio: m.audio });
      } else {
        out.push({ id, from, type });
      }
    }
  } catch (e) {
    // ignore
  }

  return out;
}

/**
 * Healthcheck
 */
app.get("/", (req, res) => {
  res.status(200).send(`${BRAND} webhook online ✅`);
});

/**
 * Webhook verify (Meta)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/**
 * Webhook receive
 */
app.post("/webhook", async (req, res) => {
  // Responde rápido pro Meta
  res.sendStatus(200);

  cleanupDedupe();

  const incoming = extractIncomingMessages(req.body);
  if (!incoming.length) return;

  for (const evt of incoming) {
    // DEDUPE
    if (evt.id && recentMessageIds.has(evt.id)) continue;
    if (evt.id) recentMessageIds.set(evt.id, now());

    const userId = evt.from;
    const session = getSession(userId);

    try {
      // Áudio (por enquanto: resposta guiada)
      if (evt.type === "audio") {
        await sendWhatsAppText(
          userId,
          `Recebi seu áudio 😄\nNo momento eu estou configurada pra responder mensagens de texto.\nSe você quiser, me manda em texto o que você precisa sobre atendimento/automação da ${BRAND}.`
        );
        continue;
      }

      const userText = (evt.text || "").trim();
      if (!userText) continue;

      console.log(`📩 (${userId}) ${userText}`);

      // PRIMEIRO CONTATO (quebra de padrão)
      if (!session.greeted) {
        session.greeted = true;
        const hook = firstContactHook();
        session.turns.push({ role: "user", content: userText });
        session.turns.push({ role: "assistant", content: hook });
        session.lastAssistant = hook;
        await sendWhatsAppText(userId, hook);
        continue;
      }

      // TRAVA DE ESCOPO
      if (!isInTriviaScope(userText)) {
        const msg = outOfScopeReply();
        // anti-loop: não repetir igual
        const finalMsg = (msg === session.lastAssistant)
          ? `Show 😊 Eu fico por aqui só no tema ${BRAND}/atendimento.\nQuer ver uma simulação de triagem no WhatsApp ou falar de módulos?`
          : msg;

        session.turns.push({ role: "user", content: userText });
        session.turns.push({ role: "assistant", content: finalMsg });
        session.lastAssistant = finalMsg;

        await sendWhatsAppText(userId, finalMsg);
        continue;
      }

      // GERA RESPOSTA IA
      const ai = await generateAIReply(session, userText);

      // Anti-loop: se vier vazio ou repetir, faz fallback elegante
      let reply = ai;
      if (!reply) {
        reply =
          `Entendi 😊\nMe diz só uma coisa: você quer **triagem**, **agendamentos** ou **pedidos/orçamentos** na sua operação?`;
      } else if (reply === session.lastAssistant) {
        reply =
          `Boa 😄 Posso te mostrar na prática:\nVocê prefere uma simulação de **triagem** ou de **agendamento**?`;
      }

      session.turns.push({ role: "user", content: userText });
      session.turns.push({ role: "assistant", content: reply });
      session.lastAssistant = reply;

      await sendWhatsAppText(userId, reply);
    } catch (err) {
      // Log útil
      const status = err?.response?.status;
      const data = err?.response?.data;

      console.error("❌ Error handling message:", status || "", data || err.message);

      // Se for erro de quota OpenAI
      if (String(err?.message || "").includes("429")) {
        try {
          await sendWhatsAppText(
            userId,
            `Eu tive um limite de uso agora (quota) 😅\nSe isso acontecer, é só ajustar o billing da OpenAI e eu volto ao normal.`
          );
        } catch (_) {}
      }
    }
  }
});

/**
 * Start
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${BRAND} rodando na porta ${PORT}`);
});
