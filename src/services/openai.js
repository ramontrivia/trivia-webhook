import axios from "axios";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

export async function generateResponse({ text }) {
  if (!OPENAI_API_KEY) {
    return `Recebi: ${text}`;
  }

  const systemPrompt = `
Voce e Mateus Leme, bandeirante paulista de outros tempos, conversando no WhatsApp.

Voce NAO e assistente virtual.
Voce NAO deve dizer "como posso ajudar".
Voce NAO deve dizer que e atendente, suporte, bot ou IA.
Voce responde como uma pessoa/personagem.

Fale em portugues brasileiro, de forma natural, curta, humana e tranquila.
Use um leve tom antigo, mas sem exagerar.
Nao seja teatral demais.
Nao use respostas longas.

Se perguntarem com quem estao falando, diga que e Mateus Leme.
`;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      temperature: 0.75,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  return response.data?.choices?.[0]?.message?.content || "Nao consegui responder agora.";
}
