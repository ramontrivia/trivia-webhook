import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAIService from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const inactivityTimers = new Map();

const getCompanyByPhoneId =
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
  Commerces.searchCommerce ||
  Commerces.findCommerces ||
  Commerces.default;

const generateResponse =
  OpenAIService.generateResponse ||
  OpenAIService.generateAIResponse ||
  OpenAIService.askOpenAI ||
  OpenAIService.default;

const sendWhatsAppMessage =
  WhatsApp.sendWhatsAppMessage ||
  WhatsApp.sendMessage ||
  WhatsApp.sendTextMessage ||
  WhatsApp.default;

function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getText(message) {
  return message?.text?.body || "";
}

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isSimpleConversation(text) {
  const msg = normalizeText(text);

  const simples = [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "td bem",
    "e ai",
    "eai",
    "beleza",
    "obrigado",
    "obrigada",
    "valeu",
    "ok"
  ];

  return simples.some((s) => msg === normalizeText(s));
}

function simpleReply(text) {
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

  return "Ora pois, saudações a vosmecê! Sou o bandeirante que voltou a Mateus Leme e sigo reconhecendo a cidade. Diga-me o que procura, que hei de tentar ajudar.";
}

function audioReply() {
  return "Ora pois, nobre vosmecê, ainda não consigo escutar mensagens de áudio. Peço que me envie por escrito, que este bandeirante há de lhe responder com gosto.";
}

function isHealthQuestion(text) {
  const msg = normalizeText(text);

  return [
    "saude",
    "posto",
    "ubs",
    "hospital",
    "upa",
    "pronto atendimento",
    "medico",
    "consulta",
    "secretaria de saude"
  ].some((term) => msg.includes(term));
}

function buildContext(commerces = []) {
  if (!Array.isArray(commerces) || commerces.length === 0) {
    return "Nenhum registro encontrado no banco de dados para esta busca.";
  }

  return commerces
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

async function saveSafe(data) {
  if (typeof saveMessage === "function") {
    await saveMessage(data);
  }
}

async function sendSafe({ phoneNumberId, to, message }) {
  if (typeof sendWhatsAppMessage !== "function") {
    throw new Error("Função de envio do WhatsApp não encontrada em whatsapp.js");
  }

  await sendWhatsAppMessage({
    phoneNumberId,
    to,
    message
  });
}

function scheduleInactivityMessage({ company, from, phoneNumberId }) {
  const key = `${company?.id || phoneNumberId}:${from}`;

  if (inactivityTimers.has(key)) {
    clearTimeout(inactivityTimers.get(key));
  }

  const timer = setTimeout(async () => {
    try {
      const message =
        "Ora pois, nobre vosmecê, sigo por aqui caso ainda precise de ajuda. Este bandeirante continua recolhendo informações pela cidade.";

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: message
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message
      });
    } catch (error) {
      console.error("Erro na mensagem de inatividade:", error);
    } finally {
      inactivityTimers.delete(key);
    }
  }, 5 * 60 * 1000);

  inactivityTimers.set(key, timer);
}

export async function handleIncomingMessage(payload) {
  try {
    if (typeof getCompanyByPhoneId !== "function") {
      throw new Error("Função para buscar empresa não encontrada em companies.js");
    }

    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];

    if (!phoneNumberId || !message) {
      return {
        success: true,
        ignored: true
      };
    }

    const from = message.from;
    const company = await getCompanyByPhoneId(phoneNumberId);

    if (!company) {
      await sendSafe({
        phoneNumberId,
        to: from,
        message:
          "Ora pois, não consegui reconhecer esta companhia por estas bandas. Peço que tente novamente mais tarde."
      });

      return {
        success: false,
        reason: "Empresa não encontrada"
      };
    }

    if (isAudio(message)) {
      const reply = audioReply();

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "user",
        content: "[ÁUDIO]"
      });

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from, phoneNumberId });

      return {
        success: true,
        type: "audio_blocked"
      };
    }

    const text = getText(message);

    if (!text) {
      const reply =
        "Ora pois, nobre vosmecê, recebi sua mensagem, mas não consegui entender o conteúdo. Envie-me por escrito o que procura, por gentileza.";

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "user",
        content: "[MENSAGEM SEM TEXTO]"
      });

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from, phoneNumberId });

      return {
        success: true,
        type: "empty_text"
      };
    }

    await saveSafe({
      company_id: company.id,
      phone: from,
      role: "user",
      content: text
    });

    if (isSimpleConversation(text)) {
      const reply = simpleReply(text);

      await saveSafe({
        company_id: company.id,
        phone: from,
        role: "assistant",
        content: reply
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivityMessage({ company, from, phoneNumberId });

      return {
        success: true,
        type: "simple_conversation"
      };
    }

    const healthPriority = isHealthQuestion(text);

    let results = [];

    if (typeof searchCommerces === "function") {
      results = await searchCommerces({
        company_id: company.id,
        query: text,
        limit: 50,
        healthPriority
      });
    }

    const context = buildContext(results);

    let reply;

    if (typeof generateResponse === "function") {
      reply = await generateResponse({
        userMessage: text,
        context,
        company,
        healthPriority
      });
    }

    const finalReply =
      reply ||
      "Ora pois, nobre vosmecê, não encontrei informação segura o bastante para lhe responder sem risco de inventar. Posso tentar buscar por outro nome ou referência.";

    await saveSafe({
      company_id: company.id,
      phone: from,
      role: "assistant",
      content: finalReply
    });

    await sendSafe({
      phoneNumberId,
      to: from,
      message: finalReply
    });

    scheduleInactivityMessage({ company, from, phoneNumberId });

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
