import * as Companies from "./companies.js";
import * as Messages   from "./messages.js";
import * as Commerces  from "./commerces.js";
import * as OpenAI     from "./openai.js";
import * as WhatsApp   from "./whatsapp.js";
import axios           from "axios";

import {
  extractCommerceFromImage,
  mergePendingCommerceImports,
  saveReadyImportToCommerces,
  resetPendingImports
} from "./importer.js";

// ── CRM ──────────────────────────────────────────────────────
import {
  getOrCreateLead,
  processCrmFromMessage,
  advanceStage,
  registerInteraction,
  STAGES
} from "./crm.js";
// ─────────────────────────────────────────────────────────────

const getCompany         = Companies.getCompanyByPhoneNumber || Companies.default;
const saveMessage        = Messages.saveMessage              || Messages.default;
const searchCommerces    = Commerces.searchCommerces         || Commerces.default;
const generateResponse   = OpenAI.generateResponse           || OpenAI.default;
const sendMessage        = WhatsApp.sendTextMessage          || WhatsApp.default;
const downloadMediaAsBase64 = WhatsApp.downloadMediaAsBase64;

const ADMIN_PHONES   = ["553199646223"];
const importSessions = new Map();

// ── Instagram Page ID da TRIVIA ───────────────────────────────
const INSTAGRAM_PAGE_ID = "17841402938162053";
const INSTAGRAM_TOKEN   = process.env.INSTAGRAM_TOKEN;
const GRAPH_VERSION     = process.env.GRAPH_VERSION || "v19.0";

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getImportKey(company, from) {
  return `${company.company_id || company.id}:${from}`;
}

function startImportSession(company, from) {
  importSessions.set(getImportKey(company, from), true);
}

function endImportSession(company, from) {
  importSessions.delete(getImportKey(company, from));
}

function hasImportSession(company, from) {
  return importSessions.has(getImportKey(company, from));
}

// ── Detecta canal (WhatsApp ou Instagram) ────────────────────
function detectChannel(payload) {
  // Instagram usa entry[0].messaging (sem changes)
  // WhatsApp usa entry[0].changes[0].value
  const entry = payload?.entry?.[0];

  if (payload?.object === "instagram") return "instagram";
  if (entry?.messaging)                return "instagram";
  if (entry?.changes)                  return "whatsapp";

  return "whatsapp";
}

// ── Parser WhatsApp ───────────────────────────────────────────
function getWhatsAppPayload(payload) {
  const value   = payload?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  return {
    channel:       "whatsapp",
    phoneNumberId: value?.metadata?.phone_number_id,
    message,
    from:          message?.from,
    text:          message?.text?.body || "",
    isStatusOnly:  !message && Array.isArray(value?.statuses)
  };
}

// ── Parser Instagram ──────────────────────────────────────────
// Formato real: entry[0].messaging[0].message.text
function getInstagramPayload(payload) {
  const messaging = payload?.entry?.[0]?.messaging?.[0];
  const message   = messaging?.message;
  const from      = messaging?.sender?.id;
  const text      = message?.text || "";

  // Ignora eventos sem mensagem (edições, reações, etc)
  const isStatusOnly = !message || !text;

  return {
    channel:       "instagram",
    phoneNumberId: INSTAGRAM_PAGE_ID,
    message:       message || null,
    from,
    text:          String(text),
    isStatusOnly
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
    "saude","posto","ubs","upa","hospital","pronto atendimento",
    "medico","consulta","clinica","farmacia"
  ].some((term) => msg.includes(term));
}

function buildContext(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items
    .slice(0, 10)
    .map((item, index) =>
      [
        `${index + 1}. Nome: ${item.nome || "Não informado"}`,
        item.telefone   ? `Telefone: ${item.telefone}`    : null,
        item.endereco   ? `Endereço: ${item.endereco}`    : null,
        item.horario    ? `Horário: ${item.horario}`      : null,
        item.tipo_google? `Tipo: ${item.tipo_google}`     : null,
        item.search_key ? `Busca: ${item.search_key}`     : null,
        item.sales_copy ? `Destaque: ${item.sales_copy}`  : null
      ]
        .filter(Boolean)
        .join(" | ")
    )
    .join("\n");
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "Não identificado";
  if (Array.isArray(value)) {
    if (value.length === 0) return "Não identificado";
    return value.map((item) => {
      if (typeof item === "object" && item !== null) {
        return Object.entries(item).map(([key, val]) => `${key}: ${val}`).join(" / ");
      }
      return String(item);
    }).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([key, val]) => `${key}: ${val}`).join(" / ");
  }
  return String(value);
}

function formatImportPreview(result) {
  const data = result?.extracted || {};
  return [
    "Cadastro consolidado com sucesso. Encontrei estes dados:",
    "",
    `Nome: ${formatValue(data.nome)}`,
    `Telefone: ${formatValue(data.telefone)}`,
    `Endereço: ${formatValue(data.enderecos?.length ? data.enderecos : data.endereco)}`,
    `Categoria: ${formatValue(data.categoria)}`,
    `Tipo: ${formatValue(data.tipo_google)}`,
    `Horário: ${formatValue(data.horario)}`,
    `Instagram: ${formatValue(data.instagram)}`,
    "",
    `Benefícios: ${formatValue(data.beneficios)}`,
    `Serviços: ${formatValue(data.servicos)}`,
    `Especialidades: ${formatValue(data.especialidades)}`,
    `Exames: ${formatValue(data.exames)}`,
    `Procedimentos: ${formatValue(data.procedimentos)}`,
    `Planos: ${formatValue(data.planos)}`,
    "",
    `Search key: ${formatValue(data.search_key)}`,
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
    company_id:      company.company_id || company.id,
    client_key:      company.client_key || String(company.id),
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
    await sendMessage({ company, to, message, text: message, body: message });
  } catch (err) {
    console.log("❌ ERRO SEND:", err.message);
  }
}

// ── Enviar mensagem pelo Instagram ────────────────────────────
async function sendInstagramMessage({ to, message }) {
  try {
    if (!INSTAGRAM_TOKEN) {
      console.log("❌ INSTAGRAM_TOKEN ausente");
      return;
    }

    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/928736843663356/messages`,
      {
        recipient: { id: to },
        message:   { text: message },
        messaging_type: "RESPONSE",
        access_token: INSTAGRAM_TOKEN
      },
      {
        headers: {
          Authorization: `Bearer ${INSTAGRAM_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log(`✅ INSTAGRAM OK: mensagem enviada para ${to}`);
  } catch (err) {
    console.log("❌ ERRO INSTAGRAM:", {
      message: err?.message,
      status:  err?.response?.status,
      data:    err?.response?.data
    });
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

// ── ADMIN ─────────────────────────────────────────────────────
async function handleAdminMessage({ company, from, text, message }) {
  const command = normalize(text);

  if (["importar comercio", "importar comércio"].includes(command)) {
    await resetPendingImports({ company, from });
    startImportSession(company, from);
    await sendSafe({ company, to: from, message: "Modo lote iniciado. Envie todas as fotos do mesmo cadastro. Quando terminar, responda FINALIZAR IMPORTACAO." });
    return true;
  }

  if (["cancelar importacao", "cancelar importação"].includes(command)) {
    await resetPendingImports({ company, from });
    endImportSession(company, from);
    await sendSafe({ company, to: from, message: "Importação cancelada. As imagens pendentes foram descartadas." });
    return true;
  }

  if (["finalizar importacao", "finalizar importação"].includes(command)) {
    if (!hasImportSession(company, from)) {
      await sendSafe({ company, to: from, message: "Não há importação em andamento. Para começar, envie IMPORTAR COMERCIO." });
      return true;
    }
    await sendSafe({ company, to: from, message: "Vou consolidar as imagens enviadas em um único cadastro." });
    const result = await mergePendingCommerceImports({ company, from });
    if (!result.success) {
      await sendSafe({ company, to: from, message: `Não consegui finalizar. Erro: ${result.error}` });
      return true;
    }
    await sendSafe({ company, to: from, message: formatImportPreview(result) });
    return true;
  }

  if (["salvar importacao", "salvar importação"].includes(command)) {
    const result = await saveReadyImportToCommerces({ company, from });
    if (!result.success) {
      await sendSafe({ company, to: from, message: `Não consegui salvar. Erro: ${result.error}` });
      return true;
    }
    endImportSession(company, from);
    await sendSafe({ company, to: from, message: `Cadastro salvo com sucesso em commerces: ${result.commerce?.nome || "sem nome"}` });
    return true;
  }

  if (isImage(message)) {
    if (!hasImportSession(company, from)) {
      await sendSafe({ company, to: from, message: "Recebi uma imagem, mas não consigo analisar imagens no atendimento comum. Escreva em texto o que deseja ou, se for cadastro administrativo, envie antes IMPORTAR COMERCIO." });
      return true;
    }
    const mediaId = message?.image?.id;
    if (!mediaId) {
      await sendSafe({ company, to: from, message: "Recebi a imagem, mas não encontrei o ID da mídia." });
      return true;
    }
    await sendSafe({ company, to: from, message: "Imagem recebida. Vou guardar esta parte para o lote." });
    const media  = await downloadMediaAsBase64({ company, mediaId });
    const result = await extractCommerceFromImage({ base64: media.base64, mime_type: media.mime_type, company, from });
    if (!result.success) {
      await sendSafe({ company, to: from, message: `Não consegui processar esta imagem. Erro: ${result.error}` });
      return true;
    }
    await sendSafe({ company, to: from, message: "Imagem processada e adicionada ao lote. Envie mais fotos ou responda FINALIZAR IMPORTACAO." });
    return true;
  }

  return false;
}

// ── HANDLER INSTAGRAM ─────────────────────────────────────────
async function handleInstagramMessage({ from, text, message, company, lead }) {
  console.log(`📸 INSTAGRAM | from: ${from} | texto: ${text}`);

  // Salva mensagem do usuário
  await saveSafe({ company, from, role: "user", content: text || "[SEM TEXTO]" });

  if (!text) {
    const reply = "Oi! 😊 Pode me enviar sua mensagem em texto?";
    await saveSafe({ company, from, role: "assistant", content: reply });
    await sendInstagramMessage({ to: from, message: reply });
    return;
  }

  // Gera resposta via IA com knowledge do Instagram
  // O knowledge da pasta /trivia/ já tem a personalidade base
  // O sistema vai usar o mesmo prompt mas com instrução de direcionar pro WhatsApp
  const instagramContext = `
CANAL: Instagram DM
INSTRUÇÃO ESPECIAL: Você está respondendo uma mensagem do Instagram.
Faça o primeiro contato de forma leve e acolhedora.
Após entender o interesse da pessoa, convide-a para continuar a conversa pelo WhatsApp da TRÍVIA: (31) 97104-5733
Não tente fechar nada pelo Instagram — apenas acolha e direcione pro WhatsApp.
  `.trim();

  let reply = await generateResponse({
    text,
    context:       instagramContext,
    company,
    from,
    healthPriority: false,
    lead
  });

  if (!reply) reply = "Oi! 😊 Que bom te ver por aqui! Me conta o que você precisa.";

  // Salva e envia
  await saveSafe({ company, from, role: "assistant", content: reply });
  await sendInstagramMessage({ to: from, message: reply });

  // Registra interação no CRM
  if (lead) {
    try {
      await registerInteraction(lead.id, "instagram_in",  text.slice(0, 200),  "client");
      await registerInteraction(lead.id, "instagram_out", reply.slice(0, 200), "mel");
    } catch (err) {
      console.log("⚠️ CRM Instagram interaction falhou:", err.message);
    }
  }
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────
export async function handleIncomingMessage(payload) {
  try {
    console.log("🔥 WEBHOOK RECEBIDO");
    console.log("📦 PAYLOAD COMPLETO:", JSON.stringify(payload, null, 2));

    // ── Detecta canal ─────────────────────────────────────────
    const channel = detectChannel(payload);
    console.log(`📡 CANAL: ${channel}`);

    // ── Parseia payload conforme canal ────────────────────────
    const parsed = channel === "instagram"
      ? getInstagramPayload(payload)
      : getWhatsAppPayload(payload);

    const { phoneNumberId, message, from, text, isStatusOnly } = parsed;

    if (isStatusOnly) {
      console.log("ℹ️ Evento de status ignorado.");
      return;
    }

    if (!message || !from) {
      console.log("❌ Payload incompleto");
      return;
    }

    // ── Busca empresa ─────────────────────────────────────────
    const company = await getCompanySafe(phoneNumberId);
    if (!company) {
      console.log("❌ Empresa não encontrada para:", phoneNumberId);
      return;
    }

    // ── CRM: busca ou cria lead ───────────────────────────────
    let lead = null;
    try {
      lead = await getOrCreateLead(from, company.company_id);
      console.log(`👤 LEAD: ${from} | fase: ${lead?.lead_phase || "frio"} | score: ${lead?.lead_score ?? 0}`);
    } catch (err) {
      console.log("⚠️ CRM getOrCreateLead falhou (não crítico):", err.message);
    }

    // ── Roteamento por canal ──────────────────────────────────
    if (channel === "instagram") {
      await handleInstagramMessage({ from, text, message, company, lead });
      return;
    }

    // ── Fluxo WhatsApp (original) ─────────────────────────────

    // Admin flow
    if (isAdmin(from)) {
      const handledByAdmin = await handleAdminMessage({ company, from, text, message });
      if (handledByAdmin) return;
    }

    // Imagem (não-admin)
    if (isImage(message)) {
      const reply = "Recebi uma imagem, mas ainda não consigo analisar imagens no atendimento comum. Escreva em texto o que precisa, por gentileza.";
      await saveSafe({ company, from, role: "user",      content: "[IMAGEM]" });
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });
      return;
    }

    // Áudio
    if (isAudio(message)) {
      const reply = "Não consigo ouvir áudio ainda. Por favor, envie sua mensagem por escrito.";
      await saveSafe({ company, from, role: "user",      content: "[ÁUDIO]" });
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });
      return;
    }

    // Salva mensagem do usuário
    await saveSafe({ company, from, role: "user", content: text || "[SEM TEXTO]" });

    if (!text) {
      const reply = "Não consegui entender sua mensagem. Pode enviar novamente por escrito?";
      await saveSafe({ company, from, role: "assistant", content: reply });
      await sendSafe({ company, to: from, message: reply });
      return;
    }

    // CRM: processa intenção
    if (lead) {
      try {
        await processCrmFromMessage(lead, text);
        await registerInteraction(lead.id, "whatsapp_in", text.slice(0, 200), "client");
      } catch (err) {
        console.log("⚠️ CRM processCrmFromMessage falhou (não crítico):", err.message);
      }
    }

    // Busca comércios
    const healthPriority = isHealthQuestion(text);
    const commerces      = await searchSafe({ company, text });
    const context        = buildContext(commerces);

    // Gera resposta via IA
    let reply = await generateResponse({
      text,
      context,
      company,
      from,
      healthPriority,
      lead
    });
    if (!reply) reply = "Não consegui responder agora.";

    // Salva e envia
    await saveSafe({ company, from, role: "assistant", content: reply });
    await sendSafe({ company, to: from, message: reply });

    // CRM: registra resposta
    if (lead) {
      try {
        await registerInteraction(lead.id, "whatsapp_out", reply.slice(0, 200), "mel");
      } catch (err) {
        console.log("⚠️ CRM registerInteraction saída falhou (não crítico):", err.message);
      }
    }

  } catch (error) {
    console.error("💥 ERRO GERAL:", error);
  }
}

export default handleIncomingMessage;
