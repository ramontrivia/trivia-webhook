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

export async function generateResponse({
  text,
  userMessage,
  message,
  context,
  company,
  from,
  healthPriority,
  lead           // ← lead completo vindo do orchestrator (com lead_phase)
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

    // ── Fase do lead (frio / morno / quente) ─────────────────
    // Se o lead existir e tiver fase definida, injeta o comportamento.
    // Default = frio (lead novo ou desconhecido entra desconfiado).
    const leadPhase     = lead?.lead_phase || "frio";
    const phaseContent  = loadKnowledgePhase(company?.client_key, leadPhase);

    console.log(`🎯 FASE DO LEAD: ${leadPhase} | from: ${from}`);

    const hasAssistantMessage = history.some((item) => item.role === "assistant");

    const cityContext =
      context && String(context).trim().length > 0
        ? String(context).trim()
        : "";

    // ── System prompt final ───────────────────────────────────
    // Ordem intencional:
    // 1. Knowledge base (quem a Mel é, sempre)
    // 2. Dados de comércio, se houver
    // 3. Regras fixas do sistema
    // 4. Comportamento da fase atual (por último = maior peso no modelo)
    const systemPrompt = `
${knowledge || "Você é um assistente útil, direto e educado."}

REGRAS DO SISTEMA:
- Nunca invente telefone
- Nunca invente endereço
- Nunca invente horário
- Nunca invente preço
- Use somente dados fornecidos
- Nunca fale sobre inteligência artificial, robô ou tecnologia interna
${cityContext ? `\nDADOS ENCONTRADOS:\n${cityContext}` : ""}
${cityContext ? "Se houver dados, use. Se não houver, responda com naturalidade sem inventar." : ""}

${phaseContent ? `\n${phaseContent}` : ""}
`.trim();

    // ── Conteúdo da mensagem do usuário ──────────────────────
    let userContent = finalText;

    if (!hasAssistantMessage && isGreetingOnly(finalText)) {
      userContent = `Primeira interação do usuário (saudação). Responda conforme sua personalidade. Mensagem: ${finalText}`;
    }
    if (!hasAssistantMessage && !isGreetingOnly(finalText)) {
      userContent = `Primeira interação com pedido. Responda direto ao ponto. Pedido: ${finalText}`;
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
        temperature: 0.4
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
