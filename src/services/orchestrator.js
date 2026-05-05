import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAI from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

import {
  extractCommerceFromImage,
  mergePendingCommerceImports,
  saveReadyImportToCommerces,
  resetPendingImports
} from "./importer.js";

const getCompany = Companies.getCompanyByPhoneNumber || Companies.default;
const saveMessage = Messages.saveMessage || Messages.default;
const searchCommerces = Commerces.searchCommerces || Commerces.default;
const generateResponse = OpenAI.generateResponse || OpenAI.default;
const sendMessage = WhatsApp.sendTextMessage || WhatsApp.default;
const downloadMediaAsBase64 = WhatsApp.downloadMediaAsBase64;

const ADMIN_PHONES = ["553199646223"];

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getPayload(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  return {
    phoneNumberId: value?.metadata?.phone_number_id,
    message,
    from: message?.from,
    text: message?.text?.body || "",
    isStatusOnly: !message && Array.isArray(value?.statuses)
  };
}

function isAdmin(from) {
  return ADMIN_PHONES.includes(String(from));
}

function isImage(message) {
  return message?.type === "image" || Boolean(message?.image);
}

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isHealthQuestion(text = "") {
  const msg = normalize(text);

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
  if (!Array.isArray(items) || items.length === 0) return "";

  return items
    .slice(0, 10)
    .map((item, index) =>
      [
        `${index + 1}. Nome: ${item.nome || "Não informado"}`,
        item.telefone ? `Telefone: ${item.telefone}` : null,
        item.endereco ? `Endereço: ${item.endereco}` : null,
        item.horario ? `Horário: ${item.horario}` : null,
        item.tipo_google ? `Tipo: ${item.tipo_google}` : null,
        item.search_key ? `Busca: ${item.search_key}` : null,
        item.sales_copy ? `Destaque: ${item.sales_copy}` : null
      ]
        .filter(Boolean)
        .join(" | ")
    )
    .join("\n");
}

function formatImportPreview(result) {
  const data = result?.extracted || {};

  return [
    "Cadastro consolidado com sucesso. Encontrei estes dados:",
    "",
    `Nome: ${data.nome || "Não identificado"}`,
    `Telefone: ${data.telefone || "Não identificado"}`,
    `Endereço: ${
      Array.isArray(data.enderecos) && data.enderecos.length
        ? data.enderecos.join(" | ")
        : data.endereco || "Não identificado"
    }`,
    `Categoria: ${data.categoria || "Não identificada"}`,
    `Tipo: ${data.tipo_google || "Não identificado"}`,
    `Horário: ${data.horario || "Não identificado"}`,
    `Instagram: ${data.instagram || "Não identificado"}`,
    "",
    `Benefícios: ${Array.isArray(data.beneficios) ? data.beneficios.join(", ") : "Não identificado"}`,
    `Especialidades: ${Array.isArray(data.especialidades) ? data.especialidades.join(", ") : "Não identificado"}`,
    `Exames/Procedimentos: ${
      [
        ...(Array.isArray(data.exames) ? data.exames : []),
        ...(Array.isArray(data.procedimentos) ? data.procedimentos : [])
      ].join(", ") || "Não identificado"
    }`,
    `Planos: ${Array.isArray(data.planos) ? data.planos.join(", ") : "Não identificado"}`,
    "",
    `Search key: ${data.search_key || "Não gerada"}`,
    "",
    "Responda SALVAR IMPORTACAO para gravar em commerces.",
    "Ou CANCELAR IMPORTACAO para descartar."
  ].join("\n");
}

async function getCompanySafe(phoneNumberId) {
  const company = await getCompany(phoneNumberId);

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
    await saveMessage({ company, from, role, content });
  } catch (err) {
    console.log("❌ ERRO SAVE:", err.message);
  }
}

async function sendSafe({ company, to, message }) {
  try {
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

async function handleAdminMessage({ company, from, text, message }) {
  const command = normalize(text);

  if (["importar comercio", "importar comércio"].includes(command)) {
    await resetPendingImports({ company, from });

    await sendSafe({
      company,
      to: from,
      message:
        "Modo lote iniciado. Envie todas as fotos do mesmo comércio. Quando terminar, responda FINALIZAR IMPORTACAO."
    });

    return true;
  }

  if (["cancelar importacao", "cancelar importação"].includes(command)) {
    await resetPendingImports({ company, from });

    await sendSafe({
      company,
      to: from,
      message: "Importação cancelada. As imagens pendentes foram descartadas."
    });

    return true;
  }

  if (["finalizar importacao", "finalizar importação"].includes(command)) {
    await sendSafe({
      company,
      to: from,
      message: "Vou consolidar as imagens enviadas em um único cadastro."
    });

    const result = await mergePendingCommerceImports({ company, from });

    if (!result.success) {
      await sendSafe({
        company,
        to: from,
        message: `Não consegui finalizar. Erro: ${result.error}`
      });

      return true;
    }

    await sendSafe({
      company,
      to: from,
      message: formatImportPreview(result)
    });

    return true;
  }

  if (["salvar importacao", "salvar importação"].includes(command)) {
    const result = await saveReadyImportToCommerces({ company, from });

    if (!result.success) {
      await sendSafe({
        company,
        to: from,
        message: `Não consegui salvar. Erro: ${result.error}`
      });

      return true;
    }

    await sendSafe({
      company,
      to: from,
      message: `Cadastro salvo com sucesso em commerces: ${result.commerce?.nome || "sem nome"}`
    });

    return true;
  }

  if (isImage(message)) {
    const mediaId = message?.image?.id;

    if (!mediaId) {
      await sendSafe({
        company,
        to: from,
        message: "Recebi a imagem, mas não encontrei o ID da mídia."
      });

      return true;
    }

    await sendSafe({
      company,
      to: from,
      message: "Imagem recebida. Vou guardar esta parte para o lote."
    });

    const media = await downloadMediaAsBase64({ company, mediaId });

    const result = await extractCommerceFromImage({
      base64: media.base64,
      mime_type: media.mime_type,
      company,
      from
    });

    if (!result.success) {
      await sendSafe({
        company,
        to: from,
        message: `Não consegui processar esta imagem. Erro: ${result.error}`
      });

      return true;
    }

    await sendSafe({
      company,
      to: from,
      message:
        "Imagem processada e adicionada ao lote. Envie mais fotos ou responda FINALIZAR IMPORTACAO."
    });

    return true;
  }

  return false;
}

export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK RECEBIDO");

    const { phoneNumberId, message, from, text, isStatusOnly } = getPayload(payload);

    if (isStatusOnly) {
      console.log("ℹ️ Evento de status ignorado.");
      return;
    }

    if (!phoneNumberId || !message || !from) {
      console.log("❌ Payload incompleto");
      return;
    }

    const company = await getCompanySafe(phoneNumberId);

    if (!company) {
      console.log("❌ Empresa não encontrada");
      return;
    }

    if (isAdmin(from)) {
      const handledByAdmin = await handleAdminMessage({
        company,
        from,
        text,
        message
      });

      if (handledByAdmin) return;
    }

    if (isAudio(message)) {
      const reply =
        "Não consigo ouvir áudio ainda. Por favor, envie sua mensagem por escrito.";

      await saveSafe({ company, from, role: "user", content: "[ÁUDIO]" });
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

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

      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });

      return;
    }

    const healthPriority = isHealthQuestion(text);

    const commerces = await searchSafe({ company, text });
    const context = buildContext(commerces);

    let reply = await generateResponse({
      text,
      context,
      company,
      from,
      healthPriority
    });

    if (!reply) reply = "Não consegui responder agora.";

    await saveSafe({ company, from, role: "assistant", content: reply });
    await sendSafe({ company, to: from, message: reply });
  } catch (error) {
    console.error("💥 ERRO GERAL:", error);
  }
}

export default handleIncomingMessage;
