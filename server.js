const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ================== ENV ==================
const PORT = process.env.PORT || 8080;

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = process.env.COMMERCIAL_PHONE; // 5531997373954
const COMMERCIAL_DISPLAY = process.env.COMMERCIAL_DISPLAY || "+55 (31) 99737-3954";

// ================== SESSÕES ==================
const sessions = new Map();

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      stage: "new",
      lastIds: new Set(),
      lead: { company: "", city: "" }
    });
  }
  return sessions.get(waId);
}

// ================== HELPERS ==================
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isCommercialIntent(text) {
  const t = normalize(text);
  const keys = [
    "contratar", "quero contratar", "fechar", "assinar",
    "comercial", "vendas", "vendedor",
    "telefone", "numero", "contato",
    "falar com humano", "atendente", "transferir"
  ];
  return keys.some(k => t.includes(k));
}

function extractLead(text) {
  const raw = text.trim();
  const parts = raw.split(/[.,;\n]/).map(p => p.trim()).filter(Boolean);

  let company = "";
  let city = "";

  if (parts.length >= 1) company = parts[0];
  if (parts.length >= 2) city = parts.slice(1).join(" ");

  const matchDe = raw.match(/\bde\s+(.+)/i);
  if (!city && matchDe) city = matchDe[1];

  if (normalize(company) === "sim") company = "";
  if (normalize(city) === "sim") city = "";

  return { company, city };
}

async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ================== OPENAI ==================
async function askAI(userText) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `
Você é Mel, atendente da TRÍVIA.
Tom humano, leve, elegante.
Foque apenas em atendimento, WhatsApp e automação.
Nunca fale sobre tokens, APIs internas ou tecnologia interna.
`
        },
        { role: "user", content: userText }
      ],
      temperature: 0.6,
      max_tokens: 200
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.choices[0].message.content.trim();
}

// ================== WEBHOOK VERIFY ==================
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === WHATSAPP_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// ================== WEBHOOK RECEIVE ==================
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const waId = message.from;
    const msgId = message.id;
    const userText = message.text?.body?.trim();

    if (!waId || !msgId || !userText) return res.sendStatus(200);

    const session = getSession(waId);

    // anti-duplicação
    if (session.lastIds.has(msgId)) return res.sendStatus(200);
    session.lastIds.add(msgId);

    // ================= PRIMEIRA MENSAGEM =================
    if (session.stage === "new") {
      session.stage = "idle";
      await sendWhatsApp(
        waId,
        `Oi 🙂 Aqui é a Mel.\n\nComo foi seu dia hoje?\n\nVocê já conhecia a TRÍVIA ou chegou aqui por curiosidade?`
      );
      return res.sendStatus(200);
    }

    // ================= INTENÇÃO COMERCIAL =================
    if (isCommercialIntent(userText)) {
      session.stage = "handoff";
    }

    // ================= HANDOFF =================
    if (session.stage === "handoff") {
      const extracted = extractLead(userText);

      if (extracted.company && !session.lead.company)
        session.lead.company = extracted.company;

      if (extracted.city && !session.lead.city)
        session.lead.city = extracted.city;

      if (!session.lead.company || !session.lead.city) {
        await sendWhatsApp(
          waId,
          "Perfeito. Para eu te colocar com o comercial agora, me diga:\n\n• Nome da empresa\n• Cidade/Estado"
        );
        return res.sendStatus(200);
      }

      // ENVIA CONTATO
      await sendWhatsApp(
        waId,
        `Fechado 😊\n\nSegue o contato do comercial:\n${COMMERCIAL_DISPLAY}\n\nEle já foi avisado que você chamou por aqui.`
      );

      // AVISA COMERCIAL
      if (COMMERCIAL_PHONE) {
        await sendWhatsApp(
          COMMERCIAL_PHONE,
          `🔔 Novo Lead TRÍVIA\n\nCliente: wa.me/${waId}\nEmpresa: ${session.lead.company}\nCidade: ${session.lead.city}`
        );
      }

      // ZERA ESTADO
      session.stage = "idle";
      session.lead = { company: "", city: "" };

      return res.sendStatus(200);
    }

    // ================= RESPOSTA NORMAL (IA) =================
    const aiReply = await askAI(userText);
    await sendWhatsApp(waId, aiReply);

    return res.sendStatus(200);
  } catch (err) {
    console.log("Erro:", err.message);
    return res.sendStatus(200);
  }
});

// ================== START ==================
app.listen(PORT, () => {
  console.log("TRÍVIA rodando na porta", PORT);
});
