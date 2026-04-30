import { getCompanyByPhoneNumber } from "./companies.js";
import { saveMessage } from "./messages.js";
import { searchCommerces } from "./commerces.js";
import { generateResponse } from "./openai.js";
import { sendTextMessage } from "./whatsapp.js";

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
    "tchau",
    "tchau boa noite",
    "ate mais",
    "até mais",
    "obrigado",
    "obrigada",
    "valeu",
    "ok"
  ].some((item) => msg === normalize(item));
}

function simpleReply(text) {
  const msg = normalize(text);

  if (msg.includes("tchau") || msg.includes("boa noite")) {
    return "Boa noite, nobre pessoa. Que vosmecê siga em paz por estas bandas. Quando precisar, este bandeirante estará por aqui.";
  }

  if (msg.includes("bom dia")) {
    return "Bom dia, nobre vosmecê! Diga-me o que procura por estas bandas, que hei de tentar ajudar.";
  }

  if (msg.includes("boa tarde")) {
    return "Boa tarde, estimado vosmecê! Diga-me, pois, o que procura por estas terras?";
  }

  if (msg.includes("obrigad") || msg === "valeu") {
    return "Ora pois, fico às ordens de vosmecê. Sempre que precisar, este bandeirante há de ajudar no que souber.";
  }

  return "Ora pois, saudações a vosmecê! Diga-me o que procura, que hei de tentar ajudar.";
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
  try {
    await saveMessage({
      client_key: company.client_key,
      company_id: company.id,
      from,
      phone: from,
      role,
      content,
      message: content
    });
  } catch (error) {
    console.error("[ORCHESTRATOR] Erro ao salvar mensagem:", {
      message: error.message,
      code: error.code,
      details: error.details
    });
  }
}

async function sendSafe({ company, to, message }) {
  await sendTextMessage(company, to, message);
}

async function searchSafe({ company, text, healthPriority }) {
  try {
    const result = await searchCommerces({
      company_id: company.id,
      client_key: company.client_key,
      query: text,
      text,
      limit: 50,
      healthPriority
    });

    return Array.isArray(result) ? result : result?.data || result?.items || [];
  } catch (error1) {
    console.error("[ORCHESTRATOR] Busca formato objeto falhou:", error1.message);
  }

  try {
    const result = await searchCommerces(text, company.id, 50, healthPriority);
    return Array.isArray(result) ? result : result?.data || result?.items || [];
  } catch (error2) {
    console.error("[ORCHESTRATOR] Busca formato argumentos falhou:", error2.message);
    return [];
  }
}

async function generateSafe({ text, context, company, from, healthPriority }) {
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
  } catch (error1) {
    console.error("[ORCHESTRATOR] OpenAI formato objeto falhou:", error1.message);
  }

  try {
    return await generateResponse(text, context, company);
  } catch (error2) {
    console.error("[ORCHESTRATOR] OpenAI formato argumentos falhou:", error2.message);
    return null;
  }
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK POST RECEBIDO");

    const { phoneNumberId, message, from, text } = getPayload(payload);

    console.log("[ORCHESTRATOR] phoneNumberId:", phoneNumberId);
    console.log("[ORCHESTRATOR] from:", from);
    console.log("[ORCHESTRATOR] text:", text);

    if (!phoneNumberId || !message || !from) {
      return { success: true, ignored: true };
    }

    const company = await getCompanyByPhoneNumber(phoneNumberId);

    if (!company) {
      console.error("[ORCHESTRATOR] Empresa não encontrada para:", phoneNumberId);
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

    await saveSafe({ company, from, role: "assistant", content: finalReply });
    await sendSafe({ company, to: from, message: finalReply });

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
