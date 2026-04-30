import * as Companies from "./companies.js";
import { saveMessage } from "./messages.js";
import { searchCommerces } from "./commerces.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const timers = new Map();

const getCompany =
  Companies.getCompanyByPhoneId ||
  Companies.findCompanyByPhoneId ||
  Companies.getCompany ||
  Companies.default;

const generateResponse =
  OpenAI.generateResponse ||
  OpenAI.generateAIResponse ||
  OpenAI.askOpenAI ||
  OpenAI.default;

const sendMessage =
  WhatsApp.sendWhatsAppMessage ||
  WhatsApp.sendMessage ||
  WhatsApp.sendTextMessage ||
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
  if (typeof getCompany !== "function") {
    throw new Error("Função de empresa não encontrada em companies.js");
  }

  try {
    return await getCompany(phoneNumberId);
  } catch (error) {
    console.error("[ORCHESTRATOR] getCompany formato texto falhou:", error.message);
    return await getCompany({ phone_id: phoneNumberId, phoneNumberId });
  }
}

async function saveSafe({ company, from, content, role }) {
  try {
    await saveMessage({
      company,
      from,
      content,
      role
    });
  } catch (error) {
    console.error("[ORCHESTRATOR] Erro ao salvar mensagem:", error.message);
  }
}

async function sendSafe({ phoneNumberId, to, message }) {
  if (typeof sendMessage !== "function") {
    throw new Error("Função de envio não encontrada em whatsapp.js");
  }

  console.log("[ORCHESTRATOR] Enviando mensagem para:", to);

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
    console.error("[ORCHESTRATOR] Envio por objeto falhou:", error.message);
  }

  try {
    await sendMessage(phoneNumberId, to, message);
    return;
  } catch (error) {
    console.error("[ORCHESTRATOR] Envio por argumentos falhou:", error.message);
  }

  await sendMessage(to, message, phoneNumberId);
}

async function searchSafe(text) {
  try {
    const result = await searchCommerces(text);
    return Array.isArray(result) ? result : result?.data || result?.items || [];
  } catch (error) {
    console.error("[ORCHESTRATOR] Erro ao buscar comércios:", error.message);
    return [];
  }
}

async function generateSafe({ text, context, company }) {
  if (typeof generateResponse !== "function") {
    return null;
  }

  try {
    return await generateResponse({
      userMessage: text,
      message: text,
      prompt: text,
      context,
      company
    });
  } catch (error) {
    console.error("[ORCHESTRATOR] OpenAI por objeto falhou:", error.message);
  }

  try {
    return await generateResponse(text, context, company);
  } catch (error) {
    console.error("[ORCHESTRATOR] OpenAI por argumentos falhou:", error.message);
    return null;
  }
}

function scheduleInactivity({ company, from, phoneNumberId }) {
  const key = `${company?.id || phoneNumberId}:${from}`;

  if (timers.has(key)) {
    clearTimeout(timers.get(key));
  }

  const timer = setTimeout(async () => {
    try {
      const message =
        "Ora pois, nobre vosmecê, sigo por aqui caso ainda precise de ajuda. Este bandeirante continua recolhendo informações pela cidade.";

      await saveSafe({
        company,
        from,
        role: "assistant",
        content: message
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message
      });
    } catch (error) {
      console.error("[ORCHESTRATOR] Erro na mensagem de inatividade:", error.message);
    } finally {
      timers.delete(key);
    }
  }, 5 * 60 * 1000);

  timers.set(key, timer);
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
      console.log("[ORCHESTRATOR] Payload ignorado");
      return { success: true, ignored: true };
    }

    const company = await getCompanySafe(phoneNumberId);

    console.log("[ORCHESTRATOR] company:", company?.id || company?.name || company?.nome);

    if (!company) {
      const reply =
        "Ora pois, não consegui reconhecer esta companhia por estas bandas. Peço que tente novamente mais tarde.";

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      return { success: false, reason: "Empresa não encontrada" };
    }

    if (isAudio(message)) {
      const reply = audioReply();

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
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivity({ company, from, phoneNumberId });

      return { success: true, type: "audio_blocked" };
    }

    if (!text) {
      const reply =
        "Ora pois, nobre vosmecê, recebi sua mensagem, mas não consegui entender o conteúdo. Envie-me por escrito o que procura, por gentileza.";

      await saveSafe({
        company,
        from,
        role: "user",
        content: "[MENSAGEM SEM TEXTO]"
      });

      await saveSafe({
        company,
        from,
        role: "assistant",
        content: reply
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivity({ company, from, phoneNumberId });

      return { success: true, type: "empty_text" };
    }

    await saveSafe({
      company,
      from,
      role: "user",
      content: text
    });

    if (isSimpleConversation(text)) {
      const reply = simpleReply(text);

      await saveSafe({
        company,
        from,
        role: "assistant",
        content: reply
      });

      await sendSafe({
        phoneNumberId,
        to: from,
        message: reply
      });

      scheduleInactivity({ company, from, phoneNumberId });

      return { success: true, type: "simple_conversation" };
    }

    const commerces = await searchSafe(text);
    const context = buildContext(commerces);

    const aiReply = await generateSafe({
      text,
      context,
      company
    });

    const finalReply =
      aiReply ||
      "Ora pois, nobre vosmecê, não encontrei informação segura o bastante para lhe responder sem risco de inventar. Posso tentar buscar por outro nome ou referência.";

    await saveSafe({
      company,
      from,
      role: "assistant",
      content: finalReply
    });

    await sendSafe({
      phoneNumberId,
      to: from,
      message: finalReply
    });

    scheduleInactivity({ company, from, phoneNumberId });

    return { success: true, type: "ai_response" };
  } catch (error) {
    console.error("[ORCHESTRATOR] ERRO GERAL:", error);
    return { success: false, error: error.message };
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
