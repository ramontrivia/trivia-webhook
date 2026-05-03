import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const getCompany =
  Companies.getCompanyByPhoneNumber ||
  Companies.default;

const saveMessage =
  Messages.saveMessage ||
  Messages.default;

const generateResponse =
  OpenAI.generateResponse ||
  OpenAI.default;

const sendMessage =
  WhatsApp.sendTextMessage ||
  WhatsApp.default;

function getPayload(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;

  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];
  const from = message?.from;
  const text = message?.text?.body || "";

  console.log("📦 PAYLOAD EXTRAÍDO:", {
    phoneNumberId,
    from,
    text
  });

  return { phoneNumberId, message, from, text };
}

function isGreeting(text = "") {
  const msg = text.toLowerCase().trim();
  return ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite"].includes(msg);
}

function simpleReply(text) {
  return "Ora pois, saudações a vosmecê! Diga-me o que procura por estas bandas.";
}

async function getCompanySafe(phoneNumberId) {
  const raw = await getCompany(phoneNumberId);

  console.log("🏢 COMPANY RAW:", raw);

  if (!raw) return null;

  return {
    ...raw,
    id: raw.id,
    company_id: raw.company_id || raw.id,
    client_key: raw.client_key || String(raw.id),
    phone_number_id:
      raw.phone_number_id ||
      raw.phoneNumberId ||
      phoneNumberId
  };
}

async function saveSafe({ company, from, role, content }) {
  try {
    await saveMessage({
      company_id: company.company_id,
      client_key: company.client_key,
      from,
      phone: from,
      role,
      content
    });

    console.log("💾 SALVO:", role, content);
  } catch (err) {
    console.log("❌ ERRO SAVE:", err.message);
  }
}

async function sendSafe({ company, to, message }) {
  try {
    console.log("📤 ENVIANDO:", message);

    await sendMessage(company, to, message);

  } catch (err) {
    console.log("❌ ERRO SEND:", err.message);
  }
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK RECEBIDO");

    const { phoneNumberId, message, from, text } = getPayload(payload);

    // 🔥 NÃO BLOQUEIA MAIS SILENCIOSAMENTE
    if (!phoneNumberId) {
      console.log("❌ phoneNumberId ausente");
      return;
    }

    if (!from) {
      console.log("❌ from ausente");
      return;
    }

    const company = await getCompanySafe(phoneNumberId);

    if (!company) {
      console.log("❌ Empresa não encontrada");
      return;
    }

    await saveSafe({
      company,
      from,
      role: "user",
      content: text || "[SEM TEXTO]"
    });

    let reply;

    if (isGreeting(text)) {
      reply = simpleReply(text);
    } else {
      reply = await generateResponse({
        text,
        company,
        from
      });
    }

    if (!reply) {
      reply = "Ora pois… não consegui responder agora.";
    }

    await saveSafe({
      company,
      from,
      role: "assistant",
      content: reply
    });

    await sendSafe({
      company,
      to: from,
      message: reply
    });

  } catch (error) {
    console.error("💥 ERRO GERAL:", error);
  }
}

export default handleIncomingMessage;
