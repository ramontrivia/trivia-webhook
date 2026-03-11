import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const PHONE_NUMBER_ID_BUSCAI = process.env.PHONE_NUMBER_ID_BUSCAI;
const WHATSAPP_TOKEN_BUSCAI = process.env.WHATSAPP_TOKEN_BUSCAI;

const COMMERCIAL_PHONE_TRIVIA = normalizePhone(process.env.COMMERCIAL_PHONE || "");
const COMMERCIAL_PHONE_BUSCAI = normalizePhone(process.env.COMMERCIAL_PHONE_BUSCAI || "");

const CLIENTS = {
  trivia: {
    assistantName: "MEL",
    companyName: "TRÍVIA",
    knowledgeDir: path.join(process.cwd(), "knowledge", "trivia"),
    phoneNumberId: PHONE_NUMBER_ID,
    token: WHATSAPP_TOKEN,
    commercialPhone: COMMERCIAL_PHONE_TRIVIA,
    allowHandoff: true,
    handoffKeywords: [
      "contratar",
      "quero contratar",
      "preço",
      "preco",
      "valor",
      "valores",
      "plano",
      "planos",
      "comercial",
      "vendedor",
      "quero comprar",
      "quero fechar",
      "falar com comercial",
      "atendente humano"
    ]
  },
  cliente_buscai: {
    assistantName: "Beatrice",
    companyName: "Busca Aí",
    knowledgeDir: path.join(process.cwd(), "knowledge", "cliente_buscai"),
    phoneNumberId: PHONE_NUMBER_ID_BUSCAI,
    token: WHATSAPP_TOKEN_BUSCAI,
    commercialPhone: COMMERCIAL_PHONE_BUSCAI,
    allowHandoff: false,
    handoffKeywords: []
  }
};

const sessions = new Map();
const knowledgeCache = new Map();
const rawFileCache = new Map();

function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}

function detectClientByPhoneNumberId(phoneNumberId) {
  if (String(phoneNumberId) === String(PHONE_NUMBER_ID_BUSCAI)) {
    return "cliente_buscai";
  }
  if (String(phoneNumberId) === String(PHONE_NUMBER_ID)) {
    return "trivia";
  }
  return null;
}

function getSession(clientKey, userId) {
  const key = `${clientKey}:${userId}`;
  if (!sessions.has(key)) {
    sessions.set(key, {
      history: [],
      lead: { name: "", company: "", city: "", state: "", segment: "" },
      leadNotified: false
    });
  }
  return sessions.get(key);
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, ts: new Date().toISOString() });
  if (session.history.length > 40) {
    session.history.shift();
  }
}

function listTxtFilesFlat(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
      .map((d) => path.join(dir, d.name))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  } catch {
    return [];
  }
}

function loadKnowledgeForClient(clientKey) {
  const cfg = CLIENTS[clientKey];
  if (!cfg) return "";

  const files = listTxtFilesFlat(cfg.knowledgeDir);
  if (!files.length) {
    console.log(`[${clientKey}] Nenhum .txt encontrado em ${cfg.knowledgeDir}`);
    return "";
  }

  const parts = [];
  const rawFiles = [];

  for (const full of files) {
    const file = path.basename(full);
    const content = fs.readFileSync(full, "utf8");

    rawFiles.push({ file, content });

    parts.push(
      `\n\n====================\nCLIENTE: ${clientKey}\nARQUIVO: ${file}\n====================\n${content}\n`
    );
  }

  rawFileCache.set(clientKey, rawFiles);
  console.log(`[${clientKey}] Knowledge carregado: ${files.length} arquivo(s)`);
  return parts.join("\n");
}

function getKnowledge(clientKey) {
  if (!knowledgeCache.has(clientKey)) {
    knowledgeCache.set(clientKey, loadKnowledgeForClient(clientKey));
  }
  return knowledgeCache.get(clientKey) || "";
}

function getRawFiles(clientKey) {
  if (!rawFileCache.has(clientKey)) {
    loadKnowledgeForClient(clientKey);
  }
  return rawFileCache.get(clientKey) || [];
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function sendWhatsAppText(clientKey, to, body) {
  const cfg = CLIENTS[clientKey];
  if (!cfg || !cfg.phoneNumberId || !cfg.token) {
    throw new Error(`Configuração inválida para ${clientKey}`);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  const res = await axios.post(graphMessagesUrl(cfg.phoneNumberId), payload, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });

  return res.data;
}

function detectIntent(clientKey, text) {
  const t = (text || "").toLowerCase().trim();
  const cfg = CLIENTS[clientKey];

  if (cfg.allowHandoff && cfg.handoffKeywords.some((k) => t.includes(k))) {
    return "handoff";
  }

  return "general";
}

function formatCommercialContact(clientKey) {
  const phone = CLIENTS[clientKey]?.commercialPhone || "";
  if (!phone) {
    return "Posso te ajudar por aqui 😊";
  }

  const pretty = `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 9)}-${phone.slice(9)}`;

  return `Fechou 😊 Aqui está o contato do nosso comercial:\n\n${pretty}\nhttps://wa.me/${phone}\n\nPode chamar por lá que eles te atendem agora.`;
}

function isCommercialNumber(clientKey, from) {
  const phone = CLIENTS[clientKey]?.commercialPhone || "";
  return phone && normalizePhone(from) === phone;
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s)]+/g);
  return matches || [];
}

function isBuscaAiLinkRequest(text) {
  const t = (text || "").toLowerCase();

  const hasIntentWord =
    t.includes("link") ||
    t.includes("baixar") ||
    t.includes("download") ||
    t.includes("instalar") ||
    t.includes("app") ||
    t.includes("aplicativo") ||
    t.includes("ios") ||
    t.includes("iphone") ||
    t.includes("android") ||
    t.includes("passageiro") ||
    t.includes("motorista");

  return hasIntentWord;
}

function buildBuscaAiLinkReply(userText) {
  const t = (userText || "").toLowerCase();
  const files = getRawFiles("cliente_buscai");

  const joined = files.map((f) => `\n${f.file}\n${f.content}\n`).join("\n");
  const urls = extractUrls(joined);

  if (!urls.length) {
    return null;
  }

  const iosUrls = urls.filter((u) => u.includes("apple.com"));
  const androidUrls = urls.filter((u) => u.includes("play.google.com"));

  const wantsIOS = t.includes("ios") || t.includes("iphone");
  const wantsAndroid = t.includes("android");
  const wantsMotorista = t.includes("motorista");
  const wantsPassageiro = t.includes("passageiro");

  let selected = [];

  if (wantsIOS) {
    selected = iosUrls;
  } else if (wantsAndroid) {
    selected = androidUrls;
  } else if (wantsMotorista) {
    selected = urls.filter((u) => u.toLowerCase().includes("driver"));
  } else if (wantsPassageiro) {
    selected = urls.filter((u) => !u.toLowerCase().includes("driver"));
  } else {
    selected = urls;
  }

  selected = [...new Set(selected)];

  if (!selected.length) {
    return null;
  }

  if (wantsIOS) {
    return `Claro 😊\n\nAqui está o link oficial para iPhone/iOS:\n${selected[0]}`;
  }

  if (wantsAndroid) {
    return `Claro 😊\n\nAqui está o link oficial para Android:\n${selected[0]}`;
  }

  if (wantsMotorista && selected.length >= 1) {
    return `Claro 😊\n\nAqui está o link oficial do app de motorista:\n${selected[0]}`;
  }

  if (wantsPassageiro && selected.length >= 1) {
    return `Claro 😊\n\nAqui está o link oficial do app de passageiro:\n${selected[0]}`;
  }

  if (iosUrls.length || androidUrls.length) {
    let msg = `Claro 😊\n\nAqui estão os links oficiais do Busca Aí:\n`;

    if (iosUrls[0]) {
      msg += `\nPassageiro iOS:\n${iosUrls[0]}\n`;
    }

    if (androidUrls[0]) {
      msg += `\nAndroid:\n${androidUrls[0]}\n`;
    }

    return msg.trim();
  }

  return `Claro 😊\n\nAqui está o link oficial:\n${selected[0]}`;
}

async function generateAssistantReply(clientKey, session, userText) {
  const cfg = CLIENTS[clientKey];
  const knowledge = getKnowledge(clientKey);

  const system = `
Você é ${cfg.assistantName}, atendente oficial da ${cfg.companyName} no WhatsApp.

REGRAS ABSOLUTAS:
- Você atende exclusivamente a ${cfg.companyName}.
- Nunca use informações, links, contatos ou regras de outra empresa.
- Use prioritariamente a base de conhecimento abaixo.
- Nunca invente links, telefones, preços, planos ou instruções.
- Se não tiver certeza absoluta de um link, não invente.
- Nunca fale sobre código, servidor, API, banco de dados, arquivos ou sistema interno.
- Respostas curtas, naturais e objetivas.
- No máximo 1 pergunta por mensagem.

BASE DE CONHECIMENTO:
${knowledge ? knowledge.slice(0, 12000) : "(sem base)"}
`.trim();

  const messages = [
    { role: "system", content: system },
    ...session.history.slice(-10).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text
    })),
    { role: "user", content: userText }
  ];

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 280
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 25000
      }
    );

    return (
      res.data?.choices?.[0]?.message?.content?.trim() ||
      "Entendi 😊 Me explica rapidinho o que você precisa."
    );
  } catch (err) {
    console.error("OpenAI error:", err?.response?.status, err?.response?.data || err.message);
    return "Entendi 😊 Me explica rapidinho o que você precisa.";
  }
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];

    if (!msg) return;

    const from = msg.from;
    const text = msg?.text?.body || "";
    if (!from || !text) return;

    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    const clientKey = detectClientByPhoneNumberId(incomingPhoneNumberId);

    if (!clientKey) {
      console.log(`Empresa não encontrada para phone_number_id=${incomingPhoneNumberId}`);
      return;
    }

    console.log(`Incoming msg | client=${clientKey} | phone_number_id=${incomingPhoneNumberId} | from=${from}`);

    if (isCommercialNumber(clientKey, from)) return;

    const session = getSession(clientKey, from);
    pushHistory(session, "user", text);

    const intent = detectIntent(clientKey, text);

    if (intent === "handoff") {
      const contact = formatCommercialContact(clientKey);
      await sendWhatsAppText(clientKey, from, contact);
      pushHistory(session, "assistant", contact);
      return;
    }

    if (clientKey === "cliente_buscai" && isBuscaAiLinkRequest(text)) {
      const directReply = buildBuscaAiLinkReply(text);

      if (directReply) {
        await sendWhatsAppText(clientKey, from, directReply);
        pushHistory(session, "assistant", directReply);
        return;
      }
    }

    const reply = await generateAssistantReply(clientKey, session, text);
    await sendWhatsAppText(clientKey, from, reply);
    pushHistory(session, "assistant", reply);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.status, err?.response?.data || err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
