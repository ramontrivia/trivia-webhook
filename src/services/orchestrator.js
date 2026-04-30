import * as Companies from "./companies.js";
import * as Messages from "./messages.js";
import * as Commerces from "./commerces.js";
import * as OpenAIService from "./openai.js";
import * as WhatsApp from "./whatsapp.js";

const inactivityTimers = new Map();

const getCompanyFn =
  Companies.getCompanyByPhoneId ||
  Companies.findCompanyByPhoneId ||
  Companies.getCompanyByPhoneIdFromDB ||
  Companies.getCompany ||
  Companies.default;

const saveMessageFn =
  Messages.saveMessage ||
  Messages.createMessage ||
  Messages.insertMessage ||
  Messages.default;

const searchCommercesFn =
  Commerces.searchCommerces ||
  Commerces.searchCommerce ||
  Commerces.findCommerces ||
  Commerces.default;

const generateResponseFn =
  OpenAIService.generateResponse ||
  OpenAIService.generateAIResponse ||
  OpenAIService.askOpenAI ||
  OpenAIService.default;

const sendMessageFn =
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

function getPayloadData(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const message = value?.messages?.[0];
  const from = message?.from;

  return { value, phoneNumberId, message, from };
}

function getText(message) {
  return message?.text?.body || "";
}

function isAudio(message) {
  return message?.type === "audio" || Boolean(message?.audio);
}

function isSimpleConversation(text) {
  const msg = normalizeText(text);

  return [
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
  ].some((item) => msg === normalizeText(item));
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
        item.h
