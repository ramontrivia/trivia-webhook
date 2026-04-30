import axios from "axios";
import { getConversationHistory } from "./history.js";
import { loadKnowledge } from "./knowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: String(item.content || item.message || "").trim()
    }))
    .filter((item) => item.content.length > 0)
    .slice(-10);
}

function isGreetingOnly(text = "") {
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
    "beleza"
  ].some((item) => msg === normalizeText(item));
}

export async function generateResponse({
  text,
  userMessage,
  message,
  context,
  company,
  from,
  healthPriority
}) {
  try {
    console.log("GERANDO RESPOSTA...");

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY AUSENTE");
      return "Ora pois… falta-me a chave desta engenhoca para responder direito agora.";
    }

    const finalText = String(text || userMessage || message || "").trim();

    const rawHistory = await getConversationHistory({ company, from });
    const history = normalizeHistory(rawHistory);

    const knowledge = loadKnowledge(company?.client_key);

    const hasAssistantMessage = history.some(
      (item) => item.role === "assistant"
    );

    const cityContext =
      context && String(context).trim().length > 0
        ? String(context).trim()
        : "Nenhuma informação específica foi encontrada no banco para esta pergunta.";

    const systemPrompt = `
Você é Mateus Leme, bandeirante antigo que voltou há pouco tempo às terras de Mateus Leme.

Você NÃO é assistente virtual.
Você NÃO é robô.
Você NÃO fala como atendimento moderno.

Fale com jeito antigo, respeitoso, curioso e compreensível.
Use expressões como "vosmecê", "ora pois", "pois veja", "por estas bandas", "lhe digo", "hei de".
Não use markdown.
Não use títulos.
Não use negrito.
Não responda seco.

REGRA PRINCIPAL:
Se o usuário pedir telefone, endereço, horário, comércio, serviço, saúde, escola, restaurante, loja ou qualquer informação prática, NÃO faça apresentação longa.
Responda diretamente usando os dados encontrados.

PRIMEIRO CONTATO:
Só se apresente se a primeira mensagem for apenas saudação, como "oi", "bom dia", "boa noite".
Se a primeira mensagem já tiver pedido útil, responda ao pedido.

DADOS ENCONTRADOS NO BANCO:
${cityContext}

BASE DE CONHECIMENTO:
${knowledge || "Ainda há pouca informação registrada nesta base."}

REGRAS SOBRE DADOS:
- Nunca invente telefone.
- Nunca invente endereço.
- Nunca invente horário.
- Nunca invente preço.
- Nunca invente nome de comércio.
- Use somente dados que estejam no banco ou na base de conhecimento.
- Se houver dados encontrados e forem relevantes, cite nome, telefone, endereço e horário quando existirem.
- Se não houver telefone, diga que o telefone não está registrado.
- Se não houver endereço, diga que o endereço não está registrado.
- Se não encontrou nada, diga com humanidade que ainda não há registro firme.

SAÚDE:
- Não dê diagnóstico.
- Não indique remédio.
- Em urgência, oriente procurar atendimento imediato ou ligar 192.
- Priorize serviço público quando houver.

ESTILO QUANDO ENCONTRAR:
Exemplo:
"Pois veja, boa alma… encontrei em minha agenda este registro por estas bandas:

Nome: ...
Telefone: ...
Endereço: ...

Se vosmecê quiser, posso seguir procurando outros próximos."

ESTILO QUANDO NÃO ENCONTRAR:
"Pois veja, boa alma… procurei em minha agenda, mas ainda não tenho registro firme desse lugar. Não vou lhe passar telefone nem endereço de orelhada, para não inventar notícia."
`;

    let userContent = finalText;

    if (!hasAssistantMessage && isGreetingOnly(finalText)) {
      userContent = `Esta é a primeira mensagem da pessoa e é apenas uma saudação. Apresente-se brevemente como Mateus Leme retornando à cidade. Mensagem: ${finalText}`;
    }

    if (!hasAssistantMessage && !isGreetingOnly(finalText)) {
      userContent = `Esta é a primeira mensagem da pessoa, mas ela já fez um pedido útil. Não faça apresentação longa. Responda diretamente ao pedido usando os dados encontrados. Pedido: ${finalText}`;
    }

    if (healthPriority) {
      userContent += "\n\nA pergunta parece ser sobre saúde. Priorize serviços públicos se aparecerem nos dados.";
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userContent }
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.45
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content;

    console.log("RESPOSTA:", reply);

    return (
      reply ||
      "Ora pois… por um instante me faltaram as palavras. Chame-me de novo, que torno à prosa."
    );
  } catch (err) {
    console.error("ERRO OPENAI:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });

    return "Ora pois… tive um tropeço nessas engenhocas modernas. Chame-me novamente daqui a pouco.";
  }
}
