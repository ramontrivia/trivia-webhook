import axios from "axios";
import { getConversationHistory } from "./history.js";
import { loadKnowledge } from "./knowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";

export async function generateResponse({ text, company, from }) {
  try {
    console.log("GERANDO RESPOSTA...");

    const history = await getConversationHistory({ company, from });
    const knowledge = loadKnowledge(company.client_key);

    const systemPrompt = `
Você é Mateus Leme.

Fale em português brasileiro, de forma natural, humana e tranquila.
Use um leve tom antigo, sem exagerar.
Seja direto, sem respostas longas.

Se perguntarem quem é você:
"Mateus Leme"

Use as informações abaixo como base de conhecimento:

${knowledge}
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: text }
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    console.log("RESPOSTA:", reply);

    return reply;

  } catch (err) {
    console.error("ERRO OPENAI:", err?.response?.data || err.message);
    return "Tive um problema ao responder.";
  }
}
