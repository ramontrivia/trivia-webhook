/**
 * TRÍVIA (Mel) - WhatsApp Cloud API + OpenAI
 * Server único, pronto pra Railway.
 *
 * Variáveis necessárias (Railway > Variables):
 * - VERIFY_TOKEN
 * - WHATSAPP_TOKEN
 * - PHONE_NUMBER_ID
 * - OPENAI_API_KEY
 */

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ====== ENV ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.warn(
    "⚠️ Falta variável. Confira: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== MEMÓRIA SIMPLES EM RAM (por número) ======
const memory = new Map();
/**
 * memory.get(from) = {
 *   lastReplyHash: string,
 *   lastUserText: string,
 *   turns: [{ role: "user"|"assistant", content: string }],
 *   lastTs: number
 * }
 */
const MAX_TURNS = 10;            // memória curta
const MEMORY_TTL_MS = 1000 * 60 * 20; // 20 min
const DEDUP_WINDOW_MS = 2500;    // evita repetição rápida

function now() {
  return Date.now();
}

function cleanOldMemory() {
  const t = now();
  for (const [k, v] of memory.entries()) {
    if (!v?.lastTs || t - v.lastTs > MEMORY_TTL_MS) memory.delete(k);
  }
}
setInterval(cleanOldMemory, 60_000).unref();

function getSession(from) {
  let s = memory.get(from);
  if (!s) {
    s = { lastReplyHash: "", lastUserText: "", turns: [], lastTs: now(), lastInboundTs: 0 };
    memory.set(from, s);
  }
  s.lastTs = now();
  return s;
}

// ====== HELPERS ======
function lower(x) {
  return (x || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

// Detecta perguntas sobre identidade (se é IA etc.) -> só revela se perguntarem
function isIdentityQuestion(text) {
  const t = lower(text);
  const patterns = [
    "voce e ia",
    "voce e uma ia",
    "voce e humano",
    "voce e real",
    "voce e um rob",
    "voce e bot",
    "isso e um bot",
    "chatbot",
    "inteligencia artificial",
    "e a trivia",
    "quem fala",
    "quem e voce",
    "quem ta falando",
    "quem e mel"
  ];
  return patterns.some(p => t.includes(p));
}

// ====== TRAVA DE ESCOPO (HARD GATE) ======
// Só permite conversa sobre TRÍVIA / atendimento / automação / whatsapp / marketing do serviço.
// Tudo fora disso -> redireciona com educação.
function isInTriviaScope(text) {
  const t = lower(text);

  // saudações e frases curtas NÃO podem liberar geral
  // (saudação é ok, mas precisa continuar dentro do assunto)
  const greetings = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "eai", "e ai", "eae"];
  if (greetings.includes(t)) return true;

  const allowedKeywords = [
    // marca / persona
    "trivia", "trivia", "trívia", "mel",

    // tema core
    "atendimento", "cliente", "clientes", "suporte", "sac", "triagem", "fila",
    "whatsapp", "wpp", "mensagem", "mensagens", "responder", "resposta",
    "automacao", "automacao", "automação", "bot", "chatbot",

    // módulos
    "agendamento", "agenda", "marcar horario", "marcar horário",
    "pedido", "pedidos", "orcamento", "orçamento", "cotacao", "cotação",
    "relatorio", "relatório", "crm", "leads",

    // comercial (sem ficar vendedor)
    "plano", "planos", "valor", "preco", "preço", "mensalidade", "contrato",
    "implantacao", "implantação", "treinamento",

    // tech
    "api", "meta", "cloud", "whatsapp business", "integracao", "integração",
    "webhook", "railway", "servidor", "nuvem",

    // marketing ligado ao serviço
    "instagram", "facebook", "marketing", "social", "redes", "anuncio", "anúncio"
  ];

  return allowedKeywords.some(k => t.includes(lower(k)));
}

// Resposta padrão fora de escopo (humanizada, sem grosseria)
function outOfScopeReply(userText) {
  const t = lower(userText);
  // se for algo pessoal aleatório, redireciona com carinho
  return (
    "Haha 😄 eu até iria nessa… mas aqui eu fico no universo de atendimento, WhatsApp e rotina com clientes.\n\n" +
    "Se você quiser, me conta rapidinho: *seu WhatsApp hoje tá mais tranquilo ou virou “99+”?*"
  );
}

// ====== WHATSAPP SEND ======
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

// ====== OPENAI: GERA RESPOSTA (Mel) ======
const SYSTEM_PROMPT = `
Você é "Mel", atendente da TRÍVIA.
A TRÍVIA é "tecnologia que responde": uma central de atendimento inteligente via WhatsApp que faz triagem, responde dúvidas sobre serviços, direciona para atendimento humano quando necessário e pode oferecer módulos (agendamento, pedidos/orçamentos, relatórios, etc.). Também pode integrar com marketing digital (Instagram/Facebook) no contexto do serviço.

REGRAS OBRIGATÓRIAS:
1) Você só conversa sobre TRÍVIA, atendimento ao cliente, WhatsApp, automação, organização de mensagens, módulos, planos e benefícios do serviço. Pode falar de tecnologia e integrações no contexto do atendimento.
2) Se o usuário puxar assunto fora desse universo (comida, religião, política, receitas, vida pessoal, casamento, etc.), NÃO responda o tema. Redirecione com leveza e simpatia para o assunto TRÍVIA/atendimento.
3) Você não é agressiva nem robótica. Seja humana, leve, empática. Pode usar 0-2 emojis.
4) Mensagens curtas e naturais. No máximo 1 pergunta por resposta.
5) Não invente fatos: se não souber, peça um detalhe.
6) Você NÃO diz que é IA a menos que o usuário pergunte diretamente (ex.: "você é IA?"). Se perguntarem, responda com honestidade e tranquilidade ("sou uma assistente virtual da TRÍVIA").
7) Evite frases repetidas ("Entendi." em loop). Varie.
8) Nunca diga "fale com um especialista". Você mesma conduz e, se preciso, oferece direcionar para humano no final.
`;

async function generateReply(from, userText) {
  const session = getSession(from);

  // anti repetição: se usuário mandou mesma coisa em sequência, não repete "entendi"
  if (lower(userText) === lower(session.lastUserText) && now() - session.lastInboundTs < 4000) {
    return "Tô aqui 🙂 Pode mandar com mais detalhes (ex.: seu segmento e o que mais te atrasa no WhatsApp hoje).";
  }

  session.lastUserText = userText;
  session.lastInboundTs = now();

  // monta mensagens
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  // memória
  for (const turn of session.turns.slice(-MAX_TURNS)) messages.push(turn);

  // input atual
  messages.push({ role: "user", content: userText });

  // chama OpenAI
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.7,
    max_tokens: 180
  });

  const reply = resp?.choices?.[0]?.message?.content?.trim() || "Oi 🙂 Como posso te ajudar com seu atendimento no WhatsApp?";
  return reply;
}

// ====== WEBHOOK VERIFY (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  console.log("❌ Falha na verificação do webhook.");
  return res.sendStatus(403);
});

// ====== WEBHOOK RECEIVE (POST) ======
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Responde 200 rápido pra Meta não reenviar
    res.sendStatus(200);

    // valida formato
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const from = msg.from; // número do usuário
    const type = msg.type;

    // Ignora mensagens enviadas pelo próprio negócio (eco)
    // Algumas contas trazem "statuses" e "messages" diferentes — aqui só processa texto
    let userText = "";

    if (type === "text") {
      userText = msg.text?.body || "";
    } else {
      // por enquanto, só texto
      userText = "[mensagem não-texto]";
    }

    console.log(`📩 (${from}) ${userText}`);

    // Dedup simples: se chegar igual muito rápido
    const session = getSession(from);
    const incomingHash = sha1(`${type}:${userText}`);
    if (incomingHash === session.lastIncomingHash && now() - session.lastIncomingAt < DEDUP_WINDOW_MS) {
      return;
    }
    session.lastIncomingHash = incomingHash;
    session.lastIncomingAt = now();

    // ===== TRAVA DE ESCOPO (ANTES da IA) =====
    // Se for fora do universo TRÍVIA, responde com redirecionamento e NÃO chama IA
    // EXCEÇÃO: se for pergunta de identidade (pra poder responder "sou assistente virtual")
    if (!isIdentityQuestion(userText) && !isInTriviaScope(userText)) {
      const msgOut = outOfScopeReply(userText);
      await sendWhatsAppText(from, msgOut);
      return;
    }

    // ===== IA =====
    const reply = await generateReply(from, userText);

    // salva memória (curta)
    session.turns.push({ role: "user", content: userText });
    session.turns.push({ role: "assistant", content: reply });
    session.turns = session.turns.slice(-MAX_TURNS);

    // anti repetição do mesmo reply
    const replyHash = sha1(reply);
    if (replyHash === session.lastReplyHash) {
      const alt = "Tô contigo 🙂 Me diz só: você quer *simular* um atendimento ou *entender como funciona* na sua empresa?";
      await sendWhatsAppText(from, alt);
      session.lastReplyHash = sha1(alt);
      return;
    }
    session.lastReplyHash = replyHash;

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("❌ Erro no webhook:", err?.response?.data || err.message);
  }
});

// ====== HEALTH ======
app.get("/", (req, res) => {
  res.status(200).send("TRÍVIA online ✅");
});

app.listen(PORT, () => {
  console.log(`✅ TRÍVIA rodando na porta ${PORT}`);
});
