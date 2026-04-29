import { getCompanyByPhoneId } from "./companies.js";
import { saveMessage } from "./messages.js";
import { searchCommerces } from "./commerces.js";
import { generateResponse } from "./openai.js";
import { sendWhatsAppMessage } from "./whatsapp.js";

const inactivityTimers = new Map();

function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isAudioMessage(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function getMessageText(message) {
  if (!message) return "";

  if (message.type === "text") {
    return message.text?.body || "";
  }

  if (message.text?.body) {
    return message.text.body;
  }

  return "";
}

function isSimpleConversation(text) {
  const msg = normalizeText(text);

  const simpleMessages = [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "e ai",
    "eai",
    "tudo bem",
    "td bem",
    "beleza",
    "obrigado",
    "obrigada",
    "valeu",
    "ok",
    "certo",
    "sim",
    "nao",
    "não"
  ];

  return simpleMessages.some((item) => msg === normalizeText(item));
}

function simpleConversationReply(text) {
  const msg = normalizeText(text);

  if (msg.includes("bom dia")) {
    return "Bom dia, nobre vosmecê! Ora pois, este bandeirante está por estas bandas recolhendo informações da cidade. Em que posso lhe servir?";
  }

  if (msg.includes("boa tarde")) {
    return "Boa tarde, estimado vosmecê! Sigo reconhecendo estas paragens e posso lhe ajudar com informações da cidade. Diga-me, pois, o que procura?";
  }

  if (msg.includes("boa noite")) {
    return "Boa noite, nobre alma! Este velho bandeirante segue atento por estas terras. Conte-me, pois, em que posso ajudar vosmecê?";
  }

  if (msg.includes("obrigad") || msg === "valeu") {
    return "Ora pois, fico às ordens de vosmecê. Sempre que precisar, este bandeirante há de ajudar no que souber.";
  }

  if (msg === "ok" || msg === "certo" || msg === "sim") {
    return "Pois muito bem, vosmecê. Sigo por aqui, pronto para auxiliar no que for preciso.";
  }

  return "Ora pois, saudações a vosmecê! Sou o bandeirante que voltou a Mateus Leme e sigo reconhecendo a cidade. Diga-me o que procura, que hei de tentar ajudar.";
}

function audioBlockedReply() {
  return "Ora pois, nobre vosmecê, ainda não consigo escutar mensagens de áudio. Peço que me envie por escrito, que este bandeirante há de lhe responder com gosto.";
}

function noCompanyReply() {
  return "Ora pois, não consegui reconhecer esta companhia por estas bandas. Peço que tente novamente mais tarde.";
}

function shouldPrioritizeHealth(text) {
  const msg = normalizeText(text);

  const healthTerms = [
    "saude",
    "saúde",
    "posto",
    "ubs",
    "hospital",
    "upa",
    "pronto atendimento",
    "medico",
    "médico",
    "consulta",
    "enfermeiro",
    "farmacia",
    "farmácia",
    "secretaria de saude",
    "secretaria de saúde"
  ];

  return healthTerms.some((term) => msg.includes(normalizeText(term)));
}

function buildCommerceContext(commerces = []) {
  if (!Array.isArray(commerces) || commerces.length === 0) {
    return "Nenhum comércio ou serviço encontrado no banco de dados para esta busca.";
  }

  return commerces
    .slice(0, 10)
    .map((item, index) => {
      const parts = [];

      parts.push(`${index + 1}. Nome: ${item.nome || "Não informado"}`);

      if (item.telefone) {
        parts.push(`Telefone: ${item.telefone}`);
      }

      if (item.endereco) {
        parts.push(`Endereço: ${item.endereco}`);
      }

      if (item.horario) {
        parts.push(`Horário: ${item.horario}`);
      }

      if (item.tipo_google) {
        parts.push(`Tipo: ${item.tipo_google}`);
      }

      if (item.search_key) {
        parts.push(`Palavras-chave: ${item.search_key}`);
      }

      return parts.join(" | ");
    })
    .join("\n");
}

function scheduleInactivityMessage({ company, from }) {
  const key = `${company.id}:${from}`;

  if (inactivityTimers.has(key)) {
    clearTimeout(inactivityTimers.get(key));
  }

  const timer = setTimeout(async () => {
    try {
      const message =
        "Ora pois, nobre vosmecê, sigo por aqui caso ainda precise de ajuda. Este bandeirante continua recolhendo informações pela cidade.";

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: message
      });

      await sendWhatsAppMessage({
        phoneNumberId: company.phone_id,
        to: from,
        message
      });
    } catch (error) {
      console.error("Erro ao enviar mensagem de inatividade:", error);
    } finally {
      inactivityTimers.delete(key);
    }
  }, 5 * 60 * 1000);

  inactivityTimers.set(key, timer);
}

export async function handleIncomingMessage(payload) {
  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];

    if (!phoneNumberId || !message) {
      return {
        success: true,
        ignored: true,
        reason: "Payload sem phone_number_id ou sem mensagem."
      };
    }

    const from = message.from;

    const company = await getCompanyByPhoneId(phoneNumberId);

    if (!company) {
      const reply = noCompanyReply();

      await sendWhatsAppMessage({
        phoneNumberId,
        to: from,
        message: reply
      });

      return {
        success: false,
        reason: "Empresa não encontrada."
      };
    }

    if (isAudioMessage(message)) {
      const reply = audioBlockedReply();

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "user",
        content: "[ÁUDIO]"
      });

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendWhatsAppMessage({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from });

      return {
        success: true,
        type: "audio_blocked"
      };
    }

    const text = getMessageText(message);

    if (!text) {
      const reply =
        "Ora pois, nobre vosmecê, recebi sua mensagem, mas não consegui entender o conteúdo. Envie-me por escrito o que procura, por gentileza.";

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "user",
        content: "[MENSAGEM SEM TEXTO]"
      });

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendWhatsAppMessage({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from });

      return {
        success: true,
        type: "empty_text"
      };
    }

    await saveMessage({
      company_id: company.id,
      phone: from,
      role: "user",
      content: text
    });

    if (isSimpleConversation(text)) {
      const reply = simpleConversationReply(text);

      await saveMessage({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendWhatsAppMessage({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from });

      return {
        success: true,
        type: "simple_conversation"
      };
    }

    const healthPriority = shouldPrioritizeHealth(text);

    const commerces = await searchCommerces({
      company_id: company.id,
      query: text,
      limit: 50,
      healthPriority
    });

    const context = buildCommerceContext(commerces);

    const reply = await generateResponse({
      userMessage: text,
      context,
      company,
      healthPriority
    });

    const finalReply =
      reply ||
      "Ora pois, nobre vosmecê, não encontrei informação segura o bastante para lhe responder sem risco de inventar. Posso tentar buscar por outro nome ou referência.";

    await saveMessage({
      company_id: company.id,
      phone: from,
      role: "assistant",
      content: finalReply
    });

    await sendWhatsAppMessage({
      phoneNumberId,
      to: from,
      message: finalReply
    });

    scheduleInactivityMessage({ company, from });

    return {
      success: true,
      type: "ai_response"
    };
  } catch (error) {
    console.error("Erro no orchestrator:", error);

    return {
      success: false,
      error: error.message
    };
  }
}

export default handleIncomingMessage;
