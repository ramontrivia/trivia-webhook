import axios from "axios";
import { getConversationHistory } from "./history.js";
import { loadKnowledge, loadKnowledgePhase } from "./knowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
      role:    item.role,
      content: String(item.content || item.message || "").trim()
    }))
    .filter((item) => item.content.length > 0)
    .slice(-10);
}

function isGreetingOnly(text = "") {
  const msg = normalizeText(text);
  return [
    "oi", "ola", "olá", "bom dia", "boa tarde",
    "boa noite", "tudo bem", "td bem", "e ai", "eai", "beleza"
  ].some((item) => msg === normalizeText(item));
}

// ── Monta o contexto do lead pra injetar no prompt ───────────
// Usa o que já foi coletado na conversa anterior.
// Só inclui campos que existem — nunca inventa.
function buildLeadContext(lead) {
  if (!lead) return "";

  const parts = [];

  if (lead.name)             parts.push(`Nome: ${lead.name}`);
  if (lead.business_name)    parts.push(`Empresa: ${lead.business_name}`);
  if (lead.business_type)    parts.push(`Segmento: ${lead.business_type}`);
  if (lead.city)             parts.push(`Cidade: ${lead.city}`);
  if (lead.pain_description) parts.push(`Dor identificada: ${lead.pain_description}`);
  if (lead.interested_modules?.length) {
    parts.push(`Módulos de interesse: ${lead.interested_modules.join(', ')}`);
  }

  if (!parts.length) return "";

  return `CONTEXTO DO LEAD (informações já coletadas em conversas anteriores):\n${parts.join('\n')}`;
}

export async function generateResponse({
  text,
  userMessage,
  message,
  context,
  company,
  from,
  healthPriority,
  lead,
  eventTrigger
}) {
  try {
    console.log("🧠 GERANDO RESPOSTA...");

    if (!OPENAI_API_KEY) {
      console.error("❌ OPENAI_API_KEY AUSENTE");
      return "Erro de configuração.";
    }

    const finalText = String(text || userMessage || message || "").trim();
    if (!finalText) return "Não consegui entender sua mensagem.";

    const rawHistory = await getConversationHistory({ company, from });
    const history    = normalizeHistory(rawHistory);

    // ── Knowledge base (personalidade, regras, tom) ──────────
    const knowledge = loadKnowledge(company?.client_key);

    // ── Fase do lead ─────────────────────────────────────────
    const leadPhase    = lead?.lead_phase || "frio";
    const phaseContent = loadKnowledgePhase(company?.client_key, leadPhase);

    console.log(`🎯 FASE DO LEAD: ${leadPhase} | from: ${from}`);

    const hasAssistantMessage = history.some((item) => item.role === "assistant");

    // ── Contexto do lead (memória de conversas anteriores) ───
    const leadContext = buildLeadContext(lead);

    const cityContext =
      context && String(context).trim().length > 0
        ? String(context).trim()
        : "";

    // ── Instrução de retorno (quando lead já conversou antes) ─
    // Evita que a MEL se apresente de novo como se fosse primeira vez.
    const returnInstruction = hasAssistantMessage
      ? `IMPORTANTE: Você já conversou com esta pessoa antes. 
NÃO se apresente novamente. NÃO diga "Oi! Sou a Mel da TRÍVIA".
Retome a conversa de forma natural e calorosa, como quem reencontra alguém conhecido.
Se tiver contexto do lead acima, use essas informações naturalmente — sem citar que você "tem registrado" ou "tem no sistema".
Exemplo de retomada: "Oi! Que bom te ver de novo 😊" ou simplesmente responda direto ao que a pessoa perguntou.`
      : "";

    // ── Contexto especial: gatilho do evento BNI Relevo ───────
    const eventContext = eventTrigger ? `
INSTRUÇÃO ESPECIAL — EVENTO BNI RELEVO:
Esta pessoa acabou de escanear o QR Code da TRÍVIA no evento BNI Relevo e mandou
mensagem pelo WhatsApp na hora, ao vivo, ainda com o celular na mão olhando o QR Code.
Ela quer ver a tecnologia funcionando de verdade, não uma demonstração morna.

Na primeira frase, surpreenda: mostre que você já sabe que ela está no evento agora,
nesse exato momento. Seja espirituosa, genuína, curta — nunca pareça script.
Não use a abertura padrão "Oi! Sou a Mel da TRÍVIA...".
Essa abertura precisa ser única, feita sob medida pra esse instante.
Depois conecte com o que a TRÍVIA faz: atendimento que nunca dorme, nunca some,
nunca deixa cliente esperando — exatamente como ela respondeu agora, na hora.
Termine com uma pergunta leve pra engajar (nome ou ramo do negócio dela).
`.trim() : "";

    // ── System prompt final ───────────────────────────────────
    // Ordem intencional:
    // 1. Knowledge base (quem a Mel é, sempre)
    // 2. Contexto do lead (memória — o que já sabe sobre a pessoa)
    // 3. Dados de comércio, se houver
    // 4. Regras fixas do sistema
    // 5. Instrução de retorno (se já conversou)
    // 6. Comportamento da fase atual (por último = maior peso)
    const systemPrompt = `
${knowledge || "Você é um assistente útil, direto e educado."}

${leadContext ? `\n${leadContext}\n` : ""}

REGRAS DO SISTEMA:
- Nunca invente telefone
- Nunca invente endereço
- Nunca invente horário
- Nunca invente preço
- Use somente dados fornecidos
- Nunca fale sobre inteligência artificial, robô ou tecnologia interna
- Nunca use markdown nas respostas (sem asteriscos, sem listas com traço, sem negrito)
- Escreva sempre em texto corrido, natural, como uma conversa de WhatsApp
${cityContext ? `\nDADOS ENCONTRADOS:\n${cityContext}` : ""}
${cityContext ? "Se houver dados, use. Se não houver, responda com naturalidade sem inventar." : ""}

${returnInstruction ? `\n${returnInstruction}\n` : ""}
${phaseContent ? `\n${phaseContent}` : ""}
${eventContext ? `\n${eventContext}` : ""}
`.trim();

    // ── Conteúdo da mensagem do usuário ──────────────────────
    let userContent = finalText;

    // Primeira interação — sem histórico
    if (!hasAssistantMessage && isGreetingOnly(finalText)) {
      userContent = `Primeira interação do usuário (saudação). Apresente-se como Mel da TRÍVIA e faça a pergunta de abertura sobre vendas. Mensagem: ${finalText}`;
    }
    if (!hasAssistantMessage && !isGreetingOnly(finalText)) {
      userContent = `Primeira interação com pedido direto. Apresente-se brevemente e responda ao pedido. Pedido: ${finalText}`;
    }

    if (healthPriority) {
      userContent += "\nSe for saúde, priorize serviços públicos.";
    }

    const messages = [
      { role: "system",  content: systemPrompt },
      ...history,
      { role: "user",    content: userContent  }
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model:       OPENAI_MODEL,
        messages,
        temperature: 0.65
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
    console.log("💬 RESPOSTA:", reply);
    return reply || "Não consegui responder agora.";

  } catch (err) {
    console.error("❌ ERRO OPENAI:", {
      message: err?.message,
      status:  err?.response?.status,
      data:    err?.response?.data
    });
    return "Erro ao gerar resposta.";
  }
}
