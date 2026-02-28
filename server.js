/**
 * TRÍVIA WhatsApp Webhook Server (Mel)
 * - Express + Axios
 * - OpenAI Responses API
 * - Dedup de mensagens
 * - Handoff Comercial (passa telefone e avisa o comercial)
 *
 * ENV obrigatórias:
 *  VERIFY_TOKEN
 *  WHATSAPP_TOKEN
 *  PHONE_NUMBER_ID
 *  GRAPH_VERSION (ex: v20.0)
 *  OPENAI_API_KEY
 *
 * ENV recomendadas:
 *  OPENAI_MODEL (ex: gpt-4.1-mini)
 *  COMMERCIAL_PHONE (ex: 5531997373954)
 */

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- ENV ----------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v20.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").replace(/\D/g, "");

// ---------- Safety: never crash ----------
process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err?.message || err);
});

// ---------- Knowledge base (optional) ----------
let TRIVIA_KNOWLEDGE = "";
try {
  const kbPath = path.join(__dirname, "knowledge", "trivia_base.txt");
  if (fs.existsSync(kbPath)) {
    TRIVIA_KNOWLEDGE = fs.readFileSync(kbPath, "utf8");
    console.log("✅ Base carregada (knowledge/trivia_base.txt)");
  } else {
    console.log("ℹ️ Base não encontrada (opcional): knowledge/trivia_base.txt");
  }
} catch (e) {
  console.log("⚠️ Falha ao carregar base:", e?.message || e);
}

// ---------- In-memory session store ----------
const sessions = new Map(); // key: wa_id -> { history: [], meta: {}, lastSeenAt, greeted, handoff, lead: {company, city} }
const seenMessageIds = new Map(); // msgId -> timestamp
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const DEDUP_TTL_MS = 1000 * 60 * 60; // 1h

function now() {
  return Date.now();
}

function cleanup() {
  const t = now();

  // sessions
  for (const [k, s] of sessions.entries()) {
    if (!s?.lastSeenAt || t - s.lastSeenAt > SESSION_TTL_MS) sessions.delete(k);
  }

  // dedup
  for (const [id, ts] of seenMessageIds.entries()) {
    if (t - ts > DEDUP_TTL_MS) seenMessageIds.delete(id);
  }
}
setInterval(cleanup, 60_000).unref();

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      history: [],
      meta: {},
      greeted: false,
      handoff: { askedLeadOnce: false, done: false },
      lead: { company: "", city: "" },
      lastSeenAt: now(),
    });
  }
  const s = sessions.get(waId);
  s.lastSeenAt = now();
  return s;
}

// ---------- Helpers ----------
function normalizeText(t) {
  return (t || "").toString().trim();
}

function lower(t) {
  return normalizeText(t).toLowerCase();
}

function isHandoffIntent(text) {
  const t = lower(text);
  const patterns = [
    "contratar",
    "quero contratar",
    "assinar",
    "fechar",
    "comercial",
    "telefone do comercial",
    "numero do comercial",
    "passa o telefone",
    "falar com atendente",
    "falar com humano",
    "transferir",
    "vendedor",
    "vendas",
    "quero comprar",
    "quero falar com",
    "contato",
    "me passa o contato",
  ];
  return patterns.some((p) => t.includes(p));
}

function looksLikeLeadInfo(text) {
  // aceita algo como: "Salão Chanel. De Mateus Leme minas gerais"
  // ou "empresa X, cidade Y"
  const t = normalizeText(text);
  if (!t) return false;
  // heurística: tem pelo menos 2 palavras e alguma pista de localidade
  const hasCityHint = /mg|sp|rj|pr|sc|rs|ba|go|df|minas|gerais|cidade|estado|de\s+[A-Za-zÀ-ÿ]/i.test(t);
  const hasCompanyHint = /empresa|sal[ãa]o|loja|cl[ií]nica|oficina|barbearia|restaurante|lanchonete|studio/i.test(t) || t.split(/\s+/).length >= 3;
  return hasCityHint || hasCompanyHint;
}

function extractLead(text) {
  // extração simples, sem forçar: pega antes do "de" como empresa; depois como cidade
  // Ex: "Salão Chanel. De Mateus Leme minas gerais"
  const raw = normalizeText(text);
  let company = "";
  let city = "";

  const m = raw.match(/(.+?)\s*(?:-|,|\.|\s)\s*de\s+(.+)/i);
  if (m) {
    company = normalizeText(m[1]).replace(/^(empresa|nome da empresa)\s*[:\-]?\s*/i, "");
    city = normalizeText(m[2]);
    return { company, city };
  }

  // caso "Empresa X, Cidade Y"
  const m2 = raw.match(/empresa\s*[:\-]?\s*(.+?)[,\.]\s*(.+)/i);
  if (m2) {
    company = normalizeText(m2[1]);
    city = normalizeText(m2[2]);
    return { company, city };
  }

  // fallback: se tiver muitas palavras, assume primeiras como empresa e últimas como cidade
  const parts = raw.split(/[,\.\-]/).map((x) => normalizeText(x)).filter(Boolean);
  if (parts.length >= 2) {
    company = parts[0];
    city = parts.slice(1).join(" - ");
  }

  return { company, city };
}

function waMeLink(phoneDigits) {
  const p = (phoneDigits || "").replace(/\D/g, "");
  if (!p) return "";
  return `https://wa.me/${p}`;
}

function shortId() {
  return crypto.randomBytes(6).toString("hex");
}

// ---------- WhatsApp API ----------
async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    };

    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    }).then((r) => {
      if (r.status >= 200 && r.status < 300) return;

      // log leve (sem flood)
      const dataStr = typeof r.data === "string" ? r.data : JSON.stringify(r.data || {});
      console.error(`❌ WhatsApp send error ${r.status}:`, dataStr.slice(0, 500));
    });
  } catch (err) {
    console.error("❌ sendWhatsAppMessage exception:", err?.message || err);
  }
}

// ---------- OpenAI ----------
function buildSystemPrompt() {
  return `
Você é a **Mel**, atendente da TRÍVIA (slogan: "tecnologia que responde").
Objetivo: criar uma conversa **humana, leve e fluida**, com educação e simpatia, poucos emojis (sem exagero).
Regra importante: você NÃO fica repetindo perguntas iguais. Se a pessoa não quiser responder algo, você segue.

ESCOPO:
- Você pode conversar sobre: atendimento ao cliente no WhatsApp, automação, triagem, agendamento, pedidos, orçamento, relatórios, integração, benefícios, implantação e planos da TRÍVIA (Basic, Plus, Master, Ultra).
- Se o usuário puxar assunto totalmente fora (receitas, espiritualidade, casamento, etc.), você responde com delicadeza, puxa de volta para atendimento/WhatsApp/TRÍVIA e oferece ajuda nesse universo. Sem bronca.

COMERCIAL/HANDOFF:
- Quando o usuário pedir "contratar", "comercial", "telefone", "falar com humano", "transferir", etc:
  1) Se já tiver empresa e cidade, confirme em 1 linha e diga que vai passar o contato.
  2) Se não tiver, pergunte UMA ÚNICA vez por empresa e cidade (curto).
  3) Se mesmo assim ele insistir só no telefone, você entrega o telefone do comercial e segue.

ESTILO:
- Começo (primeira mensagem após “oi/boa tarde”): faça conexão humana breve (ex: "Como foi seu dia?") e só depois pergunta com suavidade se ele já conhecia a TRÍVIA ou chegou por curiosidade.
- Nada de “como posso ajudar?” repetitivo.
- Evite frases tipo “universo do atendimento” repetidas. Varie.
`;
}

async function generateAIReply(session, userText) {
  const system = buildSystemPrompt();

  // histórico curto (não deixar gigante)
  const history = session.history.slice(-12).map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.text }],
  }));

  // Injeta base (se tiver) sem explodir tokens
  const kbSnippet = TRIVIA_KNOWLEDGE
    ? TRIVIA_KNOWLEDGE.slice(0, 12000)
    : "";

  const input = [
    { role: "system", content: [{ type: "text", text: system }] },
    ...(kbSnippet
      ? [{
          role: "system",
          content: [{ type: "text", text: `BASE TRÍVIA (trecho):\n${kbSnippet}` }],
        }]
      : []),
    ...history,
    { role: "user", content: [{ type: "text", text: userText }] },
  ];

  try {
    const r = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: OPENAI_MODEL,
        input,
        temperature: 0.7,
        max_output_tokens: 350,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
        validateStatus: () => true,
      }
    );

    if (!(r.status >= 200 && r.status < 300)) {
      const dataStr = typeof r.data === "string" ? r.data : JSON.stringify(r.data || {});
      console.error(`❌ OpenAI error ${r.status}:`, dataStr.slice(0, 800));
      return "Poxa, tive uma instabilidade aqui por alguns segundos 😅 Pode me mandar sua última mensagem de novo?";
    }

    // Responses API geralmente traz output_text
    const text =
      r.data?.output_text ||
      (Array.isArray(r.data?.output)
        ? r.data.output
            .flatMap((o) => o.content || [])
            .filter((c) => c.type === "output_text" || c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : "");

    const reply = normalizeText(text);
    return reply || "Me conta um pouquinho melhor — o que você quer ver na prática sobre a TRÍVIA?";
  } catch (err) {
    console.error("❌ generateAIReply exception:", err?.message || err);
    return "Dei uma travadinha rápida aqui 😅 Pode repetir a última mensagem?";
  }
}

// ---------- Comercial Handoff ----------
async function doCommercialHandoff(session, from, userText) {
  // Se já foi feito, só repassa o telefone (não loopa)
  if (session.handoff.done) {
    const phone = COMMERCIAL_PHONE ? `+${COMMERCIAL_PHONE}` : "nosso comercial";
    const link = COMMERCIAL_PHONE ? waMeLink(COMMERCIAL_PHONE) : "";
    const msg =
      COMMERCIAL_PHONE
        ? `Perfeito. Aqui está o contato do comercial: ${phone}\nSe preferir, pode chamar direto por aqui: ${link}`
        : `Perfeito. Vou te conectar ao nosso comercial agora.`;
    await sendWhatsAppMessage(from, msg);
    return;
  }

  // tenta capturar lead
  if (looksLikeLeadInfo(userText)) {
    const { company, city } = extractLead(userText);
    if (company) session.lead.company = company;
    if (city) session.lead.city = city;
  }

  const hasCompany = !!normalizeText(session.lead.company);
  const hasCity = !!normalizeText(session.lead.city);

  // Se faltou info, pergunta 1 vez só. Se insistir depois, entrega telefone.
  if ((!hasCompany || !hasCity) && !session.handoff.askedLeadOnce) {
    session.handoff.askedLeadOnce = true;
    await sendWhatsAppMessage(
      from,
      "Perfeito — eu te passo o contato do comercial agora. Antes, só pra eu encaminhar certinho: qual é o nome da sua empresa e sua cidade/estado?"
    );
    return;
  }

  // A partir daqui: NÃO pergunta de novo. Entrega contato e avisa comercial.
  const phone = COMMERCIAL_PHONE ? `+${COMMERCIAL_PHONE}` : "";
  const link = COMMERCIAL_PHONE ? waMeLink(COMMERCIAL_PHONE) : "";

  const company = session.lead.company ? session.lead.company : "(não informado)";
  const city = session.lead.city ? session.lead.city : "(não informado)";

  // mensagem para o cliente
  if (COMMERCIAL_PHONE) {
    await sendWhatsAppMessage(
      from,
      `Fechado. Vou te conectar com o comercial agora.\nContato: ${phone}\nChame direto: ${link}`
    );
  } else {
    await sendWhatsAppMessage(
      from,
      "Fechado. Vou te conectar com o comercial agora."
    );
  }

  // mensagem para o comercial (se configurado)
  if (COMMERCIAL_PHONE) {
    const lastMsgs = session.history
      .slice(-8)
      .map((m) => `${m.role === "user" ? "Cliente" : "Mel"}: ${m.text}`)
      .join("\n");

    const summary =
      `📌 *Novo lead TRÍVIA*\n` +
      `• WhatsApp cliente: +${from}\n` +
      `• Empresa: ${company}\n` +
      `• Cidade/UF: ${city}\n` +
      `• Pedido: ${normalizeText(userText).slice(0, 200)}\n\n` +
      `🧾 *Últimas mensagens:*\n${lastMsgs}`;

    // Aqui: enviamos para o seu WhatsApp comercial
    await sendWhatsAppMessage(COMMERCIAL_PHONE, summary);
  }

  session.handoff.done = true;
}

// ---------- Webhook verify ----------
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

// ---------- Webhook receive ----------
app.post("/webhook", async (req, res) => {
  // Sempre responda 200 rápido para o Meta não repetir
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const msg = messages[0];
    const msgId = msg.id;

    // dedup
    if (msgId) {
      if (seenMessageIds.has(msgId)) return;
      seenMessageIds.set(msgId, now());
    }

    const from = msg.from; // wa_id do cliente
    if (!from) return;

    // texto (por enquanto só text; áudio dá pra fazer depois)
    let userText = "";
    if (msg.type === "text") {
      userText = msg.text?.body || "";
    } else {
      // fallback amigável
      userText = "";
    }

    userText = normalizeText(userText);
    if (!userText) {
      await sendWhatsAppMessage(from, "Te ouvi por aqui 🙂 Pode me mandar em texto rapidinho?");
      return;
    }

    const session = getSession(from);

    // guarda histórico
    session.history.push({ role: "user", text: userText });

    // 1) Se for intenção de contratar/comercial → handoff determinístico (sem IA)
    if (isHandoffIntent(userText)) {
      await doCommercialHandoff(session, from, userText);
      return;
    }

    // 2) Se o usuário respondeu com lead info logo depois da pergunta do comercial,
    // e a conversa ainda está no modo handoff (askedLeadOnce == true e done == false),
    // então finaliza o handoff SEM cair em conversa aleatória.
    if (session.handoff.askedLeadOnce && !session.handoff.done && looksLikeLeadInfo(userText)) {
      await doCommercialHandoff(session, from, userText);
      return;
    }

    // 3) Primeira interação: saudação humana (sem “como posso ajudar?”)
    if (!session.greeted) {
      session.greeted = true;
      const greet =
        "Oi! 🙂 Aqui é a Mel.\n" +
        "Como foi seu dia hoje?\n\n" +
        "E me conta: você já conhecia a TRÍVIA ou caiu aqui por curiosidade?";
      session.history.push({ role: "assistant", text: greet });
      await sendWhatsAppMessage(from, greet);
      return;
    }

    // 4) IA responde normal
    const reply = await generateAIReply(session, userText);
    session.history.push({ role: "assistant", text: reply });
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("❌ webhook handler error:", err?.message || err);
    // não fazemos res aqui porque já respondemos 200
  }
});

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK TRIVIA"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
