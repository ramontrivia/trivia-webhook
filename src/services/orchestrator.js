import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const getCompany =
  Companies.getCompanyByPhoneNumber ||
  Companies.getCompanyByPhoneId ||
  Companies.findCompanyByPhoneId ||
  Companies.getCompany ||
  Companies.default;

const saveMessage =
  Messages.saveMessage ||
  Messages.createMessage ||
  Messages.insertMessage ||
  Messages.default;

const searchCommerces =
  Commerces.searchCommerces ||
  Commerces.findCommerces ||
  Commerces.searchCommerce ||
  Commerces.default;

const generateResponse =
  OpenAI.generateResponse ||
  OpenAI.generateAIResponse ||
  OpenAI.askOpenAI ||
  OpenAI.default;

const sendMessage =
  WhatsApp.sendTextMessage ||
  WhatsApp.sendWhatsAppMessage ||
  WhatsApp.sendMessage ||
  WhatsApp.default;

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getPayload(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];
  const from = message?.from;
  const text = message?.text?.body || "";

  return { phoneNumberId, message, from, text };
}

function normalizeCompany(rawCompany, phoneNumberId) {
  const company =
    rawCompany?.data?.[0] ||
    rawCompany?.data ||
    rawCompany?.company ||
    rawCompany?.[0] ||
    rawCompany;

  if (!company) return null;

  const id = company.id || company.company_id || company.client_id;

  return {
    ...company,
    id,
    company_id: company.company_id || id,
    client_key: String(company.client_key || id),
    phone_number_id:
      company.phone_number_id ||
      company.phoneNumberId ||
      company.phone_id ||
      phoneNumberId
  };
}

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isSimpleConversation(text) {
  const msg = normalize(text);

  return [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "td bem",
    "beleza",
    "obrigado",
    "obrigada",
    "valeu",
    "ok"
  ].some((item) => msg === normalize(item));
}

function simpleReply(text) {
  const msg = normalize(text);

  if (msg.includes("bom dia")) {
    return "Bom dia, nobre vosmecê! Ora pois, este bandeirante está por estas bandas recolhendo informações da cidade. Em que posso lhe servir?";
  }

  if (msg.includes("boa tarde")) {
    return "Boa tarde, estimado vosmecê! Sigo reconhecendo estas paragens e posso lhe ajudar com informações da cidade. Diga-me, pois, o que procura?";
  }

  if (msg.includes("boa noite")) {
    return "Boa noite, nobre alma! Este velho bandeirante segue atento por estas terras. Conte-me, pois, em que posso ajudar vosmecê?";
  }

  return "Ora pois, saudações a vosmecê! Diga-me o que procura, que hei de tentar ajudar.";
}

function audioReply() {
  return "Ora pois, nobre vosmecê, ainda não consigo escutar mensagens de áudio.";
}

async function getCompanySafe(phoneNumberId) {
  const raw = await getCompany(phoneNumberId);
  return normalizeCompany(raw, phoneNumberId);
}

async function saveSafe({ company, from, role, content }) {
  try {
    await saveMessage({
      company_id: company?.company_id || company?.id,
      client_key: company?.client_key,
      from,
      phone: from,
      role,
      content,
      message: content
    });
  } catch (error) {
    console.error("[SAVE ERROR]", error.message);
  }
}

async function sendSafe({ company, to, message }) {
  try {
    // 🔥 CORREÇÃO REAL AQUI
    await sendMessage(company, to, message);
  } catch (error) {
    console.error("[SEND ERROR]", error.message);
  }
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK");

    const { phoneNumberId, message, from, text } = getPayload(payload);

    if (!phoneNumberId || !message || !from) {
      return;
    }

    const company = await getCompanySafe(phoneNumberId);

    if (!company) {
      console.log("Empresa não encontrada");
      return;
    }

    if (isAudio(message)) {
      const reply = audioReply();

      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return;
    }

    await saveSafe({ company, from, role: "user", content: text });

    if (isSimpleConversation(text)) {
      const reply = simpleReply(text);

      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return;
    }

    const aiReply = await generateResponse({
      text,
      company,
      from
    });

    const finalReply =
      aiReply || "Ora pois… não consegui responder com firmeza agora.";

    await saveSafe({ company, from, role: "assistant", content: finalReply });
    await sendSafe({ company, to: from, message: finalReply });

  } catch (error) {
    console.error("[ORCHESTRATOR ERROR]", error);
  }
}

export default handleIncomingMessage;
