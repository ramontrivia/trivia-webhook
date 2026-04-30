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

  return {
    ...company,
    id: company.id || company.company_id || company.client_id,
    company_id: company.company_id || company.id || company.client_id,
    client_key: company.client_key || company.key || company.slug,
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

  if (msg.includes("obrigad") || msg === "valeu") {
    return "Ora pois, fico às ordens de vosmecê. Sempre que precisar, este bandeirante há de ajudar no que souber.";
  }

  return "Ora pois, saudações a vosmecê! Sou o bandeirante que voltou a Mateus Leme e sigo reconhecendo a cidade. Diga-me o que procura, que hei de tentar ajudar.";
}

function audioReply() {
  return "Ora pois, nobre vosmecê, ainda não consigo escutar mensagens de áudio. Peço que me envie por escrito, que este bandeirante há de lhe responder com gosto.";
}

function isHealthQuestion(text) {
  const msg = normalize(text);

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

function buildContext(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return "Nenhum registro encontrado no banco de dados para esta busca.";
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

async function saveSafe({ company, from, role, content }) {
  if (typeof saveMessage !== "function") return;

  const clientKey =
    company?.client_key ||
    company?.key ||
    company?.slug ||
    company?.company_id ||
    company?.id;

  try {
    await saveMessage({
      company_id: company?.company_id || company?.id,
      client_key: String(clientKey),
      from,
      phone: from,
      role,
      content,
      message: content
    });
  } catch (error) {
    console.error("[ORCHESTRATOR] Erro ao salvar:", {
      message: error.message,
      details: error.details,
      code: error.code
    });
  }
}

async function sendSafe({ company, to, message }) {
  if (typeof sendMessage !== "function") {
    throw new Error("Função de envio não encontrada em whatsapp.js");
  }

  await sendMessage(company, to, message);
}

async function getCompanySafe(phoneNumberId) {
  if (typeof getCompany !== "function") {
    throw new Error("Função de empresa não encontrada em companies.js");
  }

  const rawCompany = await getCompany(phoneNumberId);
  return normalizeCompany(rawCompany, phoneNumberId);
}

async function searchSafe({ company, text, healthPriority }) {
  if (typeof searchCommerces !== "function") return [];

  try {
    const result = await searchCommerces({
      company_id: company.company_id || company.id,
      companyId: company.company_id || company.id,
      client_key: company.client_key,
      query: text,
      text,
      limit: 50,
      healthPriority
    });

    return Array.isArray(result) ? result : result?.data || result?.items || [];
  } catch (error) {
    console.error("[ORCHESTRATOR] Busca objeto falhou:", error.message);
  }

  try {
    const result = await searchCommerces(text, company.company_id || company.id, 50, healthPriority);
    return Array.isArray(result) ? result : result?.data || result?.items || [];
  } catch (error) {
    console.error("[ORCHESTRATOR] Busca argumentos falhou:", error.message);
    return [];
  }
}

async function generateSafe({ text, context, company, from, healthPriority }) {
  if (typeof generateResponse !== "function") {
    return null;
  }

  try {
    return await generateResponse({
      text,
      userMessage: text,
      message: text,
      prompt: text,
      context,
      company,
      from,
      healthPriority
    });
  } catch (error) {
    console.error("[ORCHESTRATOR] OpenAI objeto falhou:", error.message);
  }

  try {
    return await generateResponse(text, context, company);
  } catch (error) {
    console.error("[ORCHESTRATOR] OpenAI argumentos falhou:", error.message);
    return null;
  }
}

export async function handleIncomingMessage(payload) {
  console.log("[ORCHESTRATOR] Payload recebido");

  try {
    const { phoneNumberId, message, from, text } = getPayload(payload);

    console.log("[ORCHESTRATOR] phoneNumberId:", phoneNumberId);
    console.log("[ORCHESTRATOR] from:", from);
    console.log("[ORCHESTRATOR] type:", message?.type);
    console.log("[ORCHESTRATOR] text:", text);

    if (!phoneNumberId || !message || !from) {
      return { success: true, ignored: true };
    }

    const company = await getCompanySafe(phoneNumberId);

    console.log("[ORCHESTRATOR] company:", {
      id: company?.id,
      company_id: company?.company_id,
      client_key: company?.client_key,
      phone_number_id: company?.phone_number_id
    });

    if (!company) {
      return { success: false, reason: "Empresa não encontrada" };
    }

    if (isAudio(message)) {
      const reply = audioReply();

      await saveSafe({ company, from, role: "user", content: "[ÁUDIO]" });
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return { success: true, type: "audio_blocked" };
    }

    if (!text) {
      const reply =
        "Ora pois, nobre vosmecê, recebi sua mensagem, mas não consegui entender o conteúdo. Envie-me por escrito o que procura, por gentileza.";

      await saveSafe({ company, from, role: "user", content: "[MENSAGEM SEM TEXTO]" });
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return { success: true, type: "empty_text" };
    }

    await saveSafe({ company, from, role: "user", content: text });

    if (isSimpleConversation(text)) {
      const reply = simpleReply(text);

      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return { success: true, type: "simple_conversation" };
    }

    const healthPriority = isHealthQuestion(text);
    const commerces = await searchSafe({ company, text, healthPriority });
    const context = buildContext(commerces);
    const aiReply = await generateSafe({ text, context, company, from, healthPriority });

    const finalReply =
      aiReply ||
      "Ora pois, nobre vosmecê, não encontrei informação segura o bastante para lhe responder sem risco de inventar. Posso tentar buscar por outro nome ou referência.";

    await saveSafe({ company, from, role: "assistant", content: finalReply });
    await sendSafe({ company, to: from, message: finalReply });

    return { success: true, type: "ai_response" };
  } catch (error) {
    console.error("[ORCHESTRATOR] ERRO GERAL:", error);
    return { success: false, error: error.message };
  }
}

export default handleIncomingMessage;
