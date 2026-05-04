import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const getCompany = Companies.getCompanyByPhoneNumber || Companies.default;
const saveMessage = Messages.saveMessage || Messages.default;
const searchCommerces = Commerces.searchCommerces || Commerces.default;
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

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isHealthQuestion(text = "") {
  const msg = String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return [
    "saude",
    "posto",
    "ubs",
    "upa",
    "hospital",
    "pronto atendimento",
    "medico",
    "consulta",
    "clinica",
    "farmacia"
  ].some((term) => msg.includes(term));
}

function buildContext(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }

  return items
    .slice(0, 10)
    .map((item, index) => {
      return [
        `${index + 1}. Nome: ${item.nome || "Não informado"}`,
        item.telefone ? `Telefone: ${item.telefone}` : null,
        item.endereco ? `Endereço: ${item.endereco}` : null,
        item.horario ? `Horário: ${item.horario}` : null,
        item.tipo_google ? `Tipo: ${item.tipo_google}` : null,
        item.search_key ? `Busca: ${item.search_key}` : null
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .join("\n");
}

async function getCompanySafe(phoneNumberId) {
  const company = await getCompany(phoneNumberId);

  console.log("🏢 COMPANY:", company);

  if (!company) return null;

  return {
    ...company,
    company_id: company.company_id || company.id,
    client_key: company.client_key || String(company.id),
    phone_number_id: company.phone_number_id || phoneNumberId
  };
}

async function saveSafe({ company, from, role, content }) {
  try {
    await saveMessage({
      company,
      from,
      role,
      content
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

async function searchSafe({ company, text }) {
  if (typeof searchCommerces !== "function") return [];

  try {
    return await searchCommerces({
      text,
      company_id: company.company_id || company.id
    });
  } catch (err) {
    console.log("❌ ERRO BUSCA COMMERCE:", err.message);
    return [];
  }
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK RECEBIDO");

    const { phoneNumberId, message, from, text } = getPayload(payload);

    console.log("📦 PAYLOAD EXTRAÍDO:", {
      phoneNumberId,
      from,
      text,
      type: message?.type
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

    if (isAudio(message)) {
      const reply =
        "Não consigo ouvir áudio ainda. Por favor, envie sua mensagem por escrito.";

      await saveSafe({
        company,
        from,
        role: "user",
        content: "[ÁUDIO]"
      });

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

      return;
    }

    await saveSafe({
      company,
      from,
      role: "user",
      content: text || "[SEM TEXTO]"
    });

    if (!text) {
      const reply =
        "Não consegui entender sua mensagem. Pode enviar novamente por escrito?";

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

      return;
    }

    const healthPriority = isHealthQuestion(text);

    const commerces = await searchSafe({
      company,
      text
    });

    console.log("🔎 COMÉRCIOS ENCONTRADOS:", commerces.length);

    const context = buildContext(commerces);

    let reply = await generateResponse({
      text,
      context,
      company,
      from,
      healthPriority
    });

    if (!reply) {
      reply = "Não consegui responder agora.";
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
