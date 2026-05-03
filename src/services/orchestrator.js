import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const getCompany = Companies.getCompanyByPhoneNumber || Companies.default;
const saveMessage = Messages.saveMessage || Messages.default;
const generateResponse = OpenAI.generateResponse || OpenAI.default;
const sendMessage = WhatsApp.sendTextMessage || WhatsApp.default;

function getPayload(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;

  return {
    phoneNumberId: value?.metadata?.phone_number_id,
    message: value?.messages?.[0],
    from: value?.messages?.[0]?.from,
    text: value?.messages?.[0]?.text?.body || ""
  };
}

function isGreeting(text = "") {
  const msg = text.toLowerCase().trim();
  return ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite"].includes(msg);
}

function simpleReply() {
  return "Ora pois, saudações a vosmecê! Diga-me o que procura por estas bandas.";
}

async function getCompanySafe(phoneNumberId) {
  const company = await getCompany(phoneNumberId);

  console.log("🏢 COMPANY RAW:", company);

  if (!company) return null;

  return {
    ...company,
    company_id: company.id,
    client_key: company.client_key || String(company.id),
    phone_number_id: company.phone_number_id || phoneNumberId
  };
}

async function saveSafe({ company, from, role, content }) {
  try {
    await saveMessage({
      company_id: company.id,
      client_key: company.client_key,
      from,
      phone: from,
      role,
      content,
      message: content
    });
  } catch (err) {
    console.log("❌ ERRO SAVE:", {
      message: err.message,
      details: err.details,
      code: err.code
    });
  }
}

async function sendSafe({ company, to, message }) {
  try {
    console.log("📤 ENVIANDO:", message);

    await sendMessage({
      company,
      to,
      message,
      text: message,
      body: message
    });
  } catch (err) {
    console.log("❌ ERRO SEND:", err.message);
  }
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK RECEBIDO");

    const { phoneNumberId, message, from, text } = getPayload(payload);

    console.log("📦 PAYLOAD EXTRAÍDO:", {
      phoneNumberId,
      from,
      text
    });

    if (!phoneNumberId || !message || !from) {
      console.log("❌ Payload incompleto");
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
      reply = simpleReply();
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
