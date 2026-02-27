/**
 * TRÍVIA - WhatsApp + OpenAI (server.js único)
 * Stack: Node + Express + Axios + OpenAI SDK
 *
 * ENV obrigatórias no Railway:
 * - VERIFY_TOKEN           (ex: trivia123)
 * - WHATSAPP_TOKEN         (token Meta/WhatsApp Cloud)
 * - PHONE_NUMBER_ID        (id do phone number do WhatsApp)
 * - OPENAI_API_KEY         (chave OpenAI)
 *
 * ENV opcionais:
 * - PORT                   (Railway já define)
 * - OPENAI_MODEL           (padrão: gpt-4o-mini)
 * - ADMIN_PHONE_E164       (ex: 55DDDNUMERO, p/ alertas futuros)
 * - BUSINESS_NAME          (padrão: TRÍVIA)
 * - BRAND_PHRASE           (padrão: "tecnologia que responde")
 */

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "5mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const BUSINESS_NAME = process.env.BUSINESS_NAME || "TRÍVIA";
const BRAND_PHRASE = process.env.BRAND_PHRASE || "tecnologia que responde";

// -----------------------------
// 1) System Prompt (identidade + regras anti-robô)
// -----------------------------
const SYSTEM_PROMPT = `
Você é a ${BUSINESS_NAME}. Frase institucional: "${BRAND_PHRASE}".

OBJETIVO
Criar uma experiência de primeiro contato no WhatsApp que seja:
- humana, elegante, descontraída (meio termo)
- surpreendente e “fora da caixa”
- muito fluida (nada de interrogatório)
- que mostre, na prática, como o atendimento rápido funciona
- com leve humor e poucos emojis (no máximo 1 por mensagem, e nem sempre)

PERSONALIDADE / TOM
- fala natural, como gente de verdade, com educação e presença
- nada de robô, nada de “papum/papum”
- sem agressividade, sem grosseria, sem perguntas invasivas
- carismática, simpática, esperta, mas profissional

REGRAS IMPORTANTES
1) Não diga que é IA no primeiro contato. Só revele se o usuário perguntar diretamente.
2) Nunca repita a mesma pergunta em sequência.
3) Se o usuário disser "não tenho esse problema" / "tá tudo ok" / "só vim ver":
   - reconheça com classe,
   - mude a abordagem para “experiência rápida” (demo) sem insistir na dor.
4) Evite coletar muitos dados. Se precisar, peça só 1 coisa por vez e com contexto.
5) Não invente dados do usuário. Se algo não foi dito, trate como desconhecido.
6) Se o usuário fizer perguntas sobre planos/serviços:
   - explique claramente que a ${BUSINESS_NAME} automatiza triagem, direciona para humano quando necessário,
     e pode habilitar módulos (agendamento, pedidos, orçamentos, relatórios).
7) Se o usuário pedir atendimento humano:
   - responda com respeito e ofereça encaminhar (sem prometer algo que você não pode executar agora).
8) Sempre priorize uma conversa fluida: uma resposta curta + 1 pergunta boa OU uma proposta de mini-simulação.
9) Se o usuário mandar palavrão, mantenha postura, não devolva palavrão. Redirecione com elegância.

ESTRUTURA DO PRIMEIRO CONTATO (GUIA, NÃO SCRIPT)
- Abertura: uma frase criativa que mostra “resposta rápida” e dá boas-vindas.
- Segunda: oferecer 2 caminhos (em uma frase):
   (a) “quer ver uma simulação de 30 segundos?” ou
   (b) “quer só entender como funciona?”
- Se escolher simulação: peça algo simples (ex: “qual é o nome da sua empresa?”) e simule triagem de forma leve.
- Fechamento: convite para conversar sobre módulos/implantação, sem pressão.

FORMATO
- Responda sempre em PT-BR
- Mensagens curtas (2 a 6 linhas) e bem humanas
- 0 ou 1 emoji por mensagem
`;

// -----------------------------
// 2) Memória curta por usuário (anti-loop + histórico + etapa)
// -----------------------------
const sessions = new Map();
// session shape:
// {
//   history: [{role:"user"/"assistant", content:"..."}],
//   stage: "start" | "discover" | "demo" | "offer" | "support",
//   lastAssistant: "texto...",
//   updatedAt: timestamp
// }

const SESSION_TTL_MS = 1000 * 60 * 30; // 30 min

function getSession(userId) {
  const now = Date.now();
  let s = sessions.get(userId);
  if (!s) {
    s = {
      history: [],
      stage: "start",
      lastAssistant: "",
      updatedAt: now,
    };
    sessions.set(userId, s);
    return s;
  }
  // expira sessão
  if (now - s.updatedAt > SESSION_TTL_MS) {
    s = {
      history: [],
      stage: "start",
      lastAssistant: "",
      updatedAt: now,
    };
    sessions.set(userId, s);
    return s;
  }
  s.updatedAt = now;
  return s;
}

function pushHistory(session, role, content) {
  session.history.push({ role, content });
  // limita histórico para não explodir tokens/custo
  if (session.history.length > 12) session.history = session.history.slice(-12);
}

function normalizeForCompare(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function isTooSimilar(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // similaridade “tosca” mas eficaz pra anti-loop:
  const minLen = Math.min(na.length, nb.length);
  if (minLen < 25) return false;
  const commonPrefix = (() => {
    let i = 0;
    while (i < minLen && na[i] === nb[i]) i++;
    return i;
  })();
  return commonPrefix / minLen > 0.8;
}

// -----------------------------
// 3) WhatsApp helpers
// -----------------------------
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

function extractIncomingText(body) {
  // padrão WhatsApp Cloud: entry -> changes -> value -> messages
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    const from = msg?.from;

    if (!msg || !from) return null;

    // texto
    if (msg.type === "text") {
      const text = msg.text?.body || "";
      return { from, text, type: "text" };
    }

    // outros tipos (por enquanto, tratamos como “não suportado”)
    return { from, text: "", type: msg.type || "unknown" };
  } catch {
    return null;
  }
}

// -----------------------------
// 4) Motor de resposta (OpenAI) + anti-loop
// -----------------------------
async function generateReply(session, userText) {
  // “volante” da etapa, mas sem engessar
  const stageHint = `Estado atual da conversa (stage): ${session.stage}.
Regra: seja fluida, humana, evite questionário. Se precisar, faça 1 pergunta inteligente por vez.`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: stageHint },
    ...session.history,
    { role: "user", content: userText },
  ];

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.8,
    presence_penalty: 0.2,
    frequency_penalty: 0.3,
  });

  let answer = resp.choices?.[0]?.message?.content?.trim() || "";

  // Anti-loop: se vier igual ou muito parecido com a última resposta, força variação
  if (isTooSimilar(answer, session.lastAssistant)) {
    const retryMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content:
          "Atenção: sua última resposta ficou repetitiva. Gere uma resposta diferente, mais curta, com outra abordagem, sem repetir perguntas.",
      },
      ...session.history,
      { role: "user", content: userText },
    ];

    const retry = await openai.chat.completions.create({
      model: MODEL,
      messages: retryMessages,
      temperature: 0.95,
      presence_penalty: 0.35,
      frequency_penalty: 0.45,
    });

    answer = retry.choices?.[0]?.message?.content?.trim() || answer;
  }

  // Se o modelo vier vazio, fallback humano
  if (!answer) {
    answer =
      "Oi! Eu tô por aqui 😊 Me diz: você quer só entender como a TRÍVIA funciona, ou prefere ver uma mini-simulação rapidinha?";
  }

  // Atualiza stage com heurística leve (sem travar)
  const lower = userText.toLowerCase();
  if (session.stage === "start") session.stage = "discover";
  if (lower.includes("simulação") || lower.includes("simulacao")) session.stage = "demo";
  if (lower.includes("preço") || lower.includes("valor") || lower.includes("planos"))
    session.stage = "offer";
  if (lower.includes("suporte") || lower.includes("erro")) session.stage = "support";

  session.lastAssistant = answer;

  return answer;
}

// -----------------------------
// 5) Webhook verify (GET)
// -----------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// -----------------------------
// 6) Webhook messages (POST)
// -----------------------------
app.post("/webhook", async (req, res) => {
  // responder rápido pro WhatsApp
  res.sendStatus(200);

  const incoming = extractIncomingText(req.body);
  if (!incoming) return;

  const { from, text, type } = incoming;
  const session = getSession(from);

  try {
    // Se não for texto (áudio, imagem etc.), responda com elegância
    if (type !== "text") {
      const msg =
        "Cheguei 😊 Por enquanto eu entendo melhor mensagens em texto. Se você me mandar por escrito (bem curtinho mesmo), eu te respondo rapidinho.";
      await sendWhatsAppText(from, msg);
      pushHistory(session, "assistant", msg);
      return;
    }

    const userText = (text || "").trim();

    if (!userText) {
      const msg = "Eu vi sua mensagem aqui 🙂 Me manda em texto só mais uma vez?";
      await sendWhatsAppText(from, msg);
      pushHistory(session, "assistant", msg);
      return;
    }

    pushHistory(session, "user", userText);

    const reply = await generateReply(session, userText);

    await sendWhatsAppText(from, reply);
    pushHistory(session, "assistant", reply);

    console.log("✅ Mensagem processada:", from, userText);
  } catch (err) {
    // Tratamento especial para quota/429
    const status = err?.response?.status;
    const apiMsg =
      err?.response?.data?.error?.message ||
      err?.message ||
      "Erro desconhecido";

    console.error("❌ Erro no webhook:", status, apiMsg);

    let fallback =
      "Poxa — tive um soluço técnico aqui 😅 Pode me mandar sua última mensagem de novo em alguns instantes?";

    // quota / billing / 429
    if (String(apiMsg).includes("429") || String(apiMsg).toLowerCase().includes("quota")) {
      fallback =
        "Agora eu tô temporariamente sem fôlego pra pensar (limite do plano/uso). 😅\n" +
        "Se você quiser, eu posso te explicar como ajustar isso rapidinho: é só habilitar faturamento/créditos na OpenAI e eu volto 100%.";
    }

    try {
      await sendWhatsAppText(from, fallback);
      pushHistory(session, "assistant", fallback);
    } catch (sendErr) {
      console.error("❌ Falha ao enviar fallback:", sendErr?.message || sendErr);
    }
  }
});

// -----------------------------
// 7) Healthcheck
// -----------------------------
app.get("/", (_, res) => {
  res.status(200).send(`${BUSINESS_NAME} online ✅`);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
