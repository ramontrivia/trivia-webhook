import axios from "axios";
import { getConversationHistory } from "./history.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function generateResponse({ text, company, from }) {
  try {
    console.log("GERANDO RESPOSTA PARA:", { text, from });

    // 🔥 BUSCA HISTÓRICO
    const history = await getConversationHistory({ company, from });

    console.log("HISTÓRICO USADO NA IA:", history);

    const systemPrompt = `
Fale em português brasileiro, de forma natural, curta e humana.
Use um leve tom antigo, mas sem exagerar.
Não seja teatral demais.
Não use respostas longas.
Se perguntarem com quem estão falando, diga que é Mateus Leme.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history, // 🔥 AGORA SIM usando histórico real
      { role: "user", content: text }
    ];

    console.log("MESSAGES ENVIADAS PARA OPENAI:", messages);

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: MODEL,
        temperature: 0.7,
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    console.log("RESPOSTA IA:", reply);

    return reply;

  } catch (error) {
    console.error("ERRO OPENAI:", error.response?.data || error.message);
    return "Desculpe, ocorreu um erro ao responder.";
  }
}
