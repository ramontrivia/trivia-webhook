import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

function pickFunction(moduleObject, names = []) {
  for (const name of names) {
    if (typeof moduleObject[name] === "function") {
      return moduleObject[name];
    }
  }

  if (typeof moduleObject.default === "function") {
    return moduleObject.default;
  }

  const functionExports = Object.values(moduleObject).filter(
    (value) => typeof value === "function"
  );

  if (functionExports.length === 1) {
    return functionExports[0];
  }

  return null;
}

const getCompany = pickFunction(Companies, [
  "getCompanyByPhoneId",
  "getCompanyByPhoneNumberId",
  "findCompanyByPhoneId",
  "findCompanyByPhoneNumberId",
  "getCompanyByMetaPhoneId",
  "findCompanyByMetaPhoneId",
  "getCompanyByWhatsappPhoneId",
  "findCompanyByWhatsappPhoneId",
  "getCompany",
  "findCompany",
  "getCompanyByPhone",
  "findCompanyByPhone",
  "companyByPhoneId"
]);

const saveMessage = pickFunction(Messages, [
  "saveMessage",
  "createMessage",
  "insertMessage",
  "addMessage"
]);

const searchCommerces = pickFunction(Commerces, [
  "searchCommerces",
  "findCommerces",
  "searchCommerce",
  "getCommerces",
  "buscarComercios"
]);

const generateResponse = pickFunction(OpenAI, [
  "generateResponse",
  "generateAIResponse",
  "askOpenAI"
]);

const sendMessage = pickFunction(WhatsApp, [
  "sendWhatsAppMessage",
  "sendMessage",
  "sendTextMessage",
  "sendWhatsappMessage"
]);

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

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isSimpleConversation(text) {
  const msg = normalize(text);

  const simple = [
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
    "ok",
    "tchau",
    "ate mais",
    "até mais"
  ];

  return simple.some((item) => msg === normalize(item));
}

function simpleReply(text) {
  const msg = normalize(text);

  if (msg.includes("bom dia")) {
    return "Bom dia, nobre vosmecê! Ora pois, sigo por estas bandas recolhendo informações da cidade. Diga-me o que procura, que hei de tentar ajudar.";
  }

  if (msg.includes("boa tarde")) {
    return "Boa tarde, estimado vosmecê! Sigo reconhecendo estas paragens e posso lhe ajudar com informações da cidade. Diga-me, pois, o que procura?";
  }

  if (msg.includes("boa noite") || msg.includes("tchau")) {
    return "Boa noite, nobre pessoa. Que vosmecê siga em paz por estas bandas. Quando precisar, este bandeirante estará por aqui.";
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

async function getCompanySafe(phoneNumberId) {
  console.log("[ORCHESTRATOR] Exports companies.js:", Object.keys(Companies));

  if (typeof getCompany !== "function") {
    throw new Error(
      "Função de empresa não encontrada em companies.js. Exports disponíveis: " +
        Object.keys(Companies).join(", ")
    );
  }

  try {
    return await getCompany(phoneNumberId);
  } catch (error1) {
    console.error("[ORCHESTRATOR] Empresa formato texto falhou:", error1.message);
  }

  try {
    return await getCompany({
      phone_id: phoneNumberId,
      phoneNumberId,
      phone_number_id: phoneNumberId
    });
  } catch (error2) {
    console.error("[ORCHESTRATOR] Empresa formato objeto falhou:", error2.message);
    throw error2;
  }
}

async function saveSafe(data) {
  if (typeof saveMessage !== "function") {
    console.error("[ORCHESTRATOR] saveMessage não encontrado:", Object.keys(Messages));
    return;
  }

  try {
    await saveMessage(data);
  } catch (error) {
    console.error("[ORCHESTRATOR] Erro ao salvar:", error.message);
  }
}

async function sendSafe({ phoneNumberId, to, message }) {
  if (typeof sendMessage !== "function") {
    throw new Error(
      "Função de envio não encontrada em whatsapp.js. Exports disponíveis: " +
        Object.keys(WhatsApp).join(", ")
    );
  }

  try {
    await sendMessage({
      phoneNumberId,
      phone_number_id: phoneNumberId,
      to,
      message,
      text: message,
      body: message
    });
    return;
  } catch (error) {
    console.error("[ORCHESTRATOR] Envio objeto falhou:", error.message);
  }

  try {
    await sendMessage(phoneNumberId, to, message);
    return;
  } catch (error) {
    console.error("[ORCHESTRATOR] Envio argumentos falhou:", error.message);
  }

  await sendMessage(to, message, phoneNumberId);
}

async function searchSafe({ company, text, healthPriority }) {
  if (typeof searchCommerces !== "function") {
    console.error("[ORCHESTRATOR] searchCommerces não encontrado:", Object.keys(Commerces));
    return [];
  }

  try {
    const result = await searchCommerces({
      company_id: company.id,
      companyId: company.id,
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
    const result = await searchCommerces(text, company.id, 50, healthPriority);
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

    if (!company) {
      await sendSafe({
        phoneNumberId,
        to: from,
        message:
          "Ora pois, não consegui reconhecer esta companhia por estas bandas. Peço que tente novamente mais tarde."
      });

      return { success: false, reason: "Empresa não encontrada" };
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

      await sendSafe({ phoneNumberId, to: from, message: reply });

      return { success: true, type: "audio_blocked" };
    }

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

      await sendSafe({ phoneNumberId, to: from, message: reply });

      return { success: true, type: "empty_text" };
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

      await sendSafe({ phoneNumberId, to: from, message: reply });

      return { success: true, type: "simple_conversation" };
    }

    const healthPriority = isHealthQuestion(text);

    const commerces = await searchSafe({
      company,
      text,
      healthPriority
    });

    const context = buildContext(commerces);

    const aiReply = await generateSafe({
      text,
      context,
      company,
      from,
      healthPriority
    });

    const finalReply =
      aiReply ||
      "Ora pois, nobre vosmecê, não encontrei informação segura o bastante para lhe responder sem risco de inventar. Posso tentar buscar por outro nome ou referência.";

    await saveSafe({
      company_id: company.id,
      phone: from,
      role: "assistant",
      content: finalReply
    });

    await sendSafe({ phoneNumberId, to: from, message: finalReply });

    return { success: true, type: "ai_response" };
  } catch (error) {
    console.error("[ORCHESTRATOR] ERRO GERAL:", error);

    return {
      success: false,
      error: error.message
    };
  }
}

export {
  handleIncomingMessage as handleMessage,
  handleIncomingMessage as handleWebhook,
  handleIncomingMessage as processMessage,
  handleIncomingMessage as processIncomingMessage,
  handleIncomingMessage as orchestrateMessage
};

export default handleIncomingMessage;
