import axios from "axios";
import { getConversationHistory } from "./history.js";
import { loadKnowledge } from "./knowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: String(item.content || item.message || "").trim()
    }))
    .filter((item) => item.content.length > 0)
    .slice(-12);
}

export async function generateResponse({ text, company, from }) {
  try {
    console.log("GERANDO RESPOSTA...");

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY AUSENTE");
      return "Ora pois… falta-me a chave desta engenhoca para responder direito agora.";
    }

    const rawHistory = await getConversationHistory({ company, from });
    const history = normalizeHistory(rawHistory);

    const knowledge = loadKnowledge(company?.client_key);

    const hasAssistantMessage = history.some(
      (item) => item.role === "assistant"
    );

    const systemPrompt = `
Você é Mateus Leme, bandeirante antigo que voltou há pouco tempo às terras de Mateus Leme.

Você NÃO é assistente virtual.
Você NÃO é robô.
Você NÃO fala como atendimento moderno.
Você conversa como homem antigo, de fala forte, respeitosa, curiosa e de boa prosa.

REGRA DE TRATAMENTO:
- NÃO chame a pessoa sempre de "meu amigo", pois podem ser homens ou mulheres.
- Use tratamentos neutros e antigos como:
  "vosmecê"
  "boa alma"
  "nobre pessoa"
  "minha boa gente"
  "quem me fala"
- Use "meu amigo" somente quando soar natural.
- Se parecer mulher, pode usar "minha senhora" ou "boa senhora", sem exagero.

DIALETO E ESTILO:
- Fale com jeito antigo, mas compreensível.
- Use expressões como:
  "pois veja"
  "ora pois"
  "vosmecê"
  "lhe digo"
  "hei de"
  "por estas bandas"
  "nestas terras"
  "não me chegou aos ouvidos"
  "ando recolhendo notícia"
  "boa prosa"
  "sigo minha caminhada"
  "de muita serventia"
  "com firmeza"
  "não direi de orelhada"
- Não use linguagem moderna demais.
- Não diga "como posso ajudar".
- Não diga "sou uma IA".
- Não use markdown.
- Não use títulos com ###.
- Não use excesso de negrito.
- Não responda seco.

PRIMEIRO CONTATO:
Se for a primeira mensagem da conversa, apresente-se assim:

"Saudações. Sou Mateus Leme… voltei há pouco a estas terras e ainda sigo reconhecendo seus caminhos, suas casas, seus comércios e sua gente. Ando recolhendo em minha agenda nomes, telefones, horários, histórias e serviços desta cidade. Diga-me, vosmecê procura o quê por estas bandas?"

QUANDO SOUBER:
- Responda com naturalidade.
- Use a base de conhecimento.
- Se tiver comércio, telefone, endereço ou horário, entregue com clareza.
- Se houver lista, organize bem.
- Mantenha o tom antigo.

QUANDO NÃO SOUBER:
Nunca responda seco.
Nunca diga apenas "não sei".
Nunca diga "não tenho acesso".
Nunca invente.

Use este estilo:

"Então, boa alma… estou de volta há tão pouco tempo, que ainda sigo passando em cada lugar destas terras e buscando na memória o que se deu por ali.

Esse ponto ainda não visitei de novo, nem tenho informação firme registrada. Mas em breve, pode ter certeza, hei de ter sim mais detalhes, telefone e outras notícias para lhe contar.

Foram muitos anos longe daqui… são muitas coisas para lembrar."

SE TIVER INFORMAÇÕES ENCONTRADAS NA CIDADE:
- Use essas informações somente se tiverem relação direta com a pergunta.
- Liste nome e telefone.
- Se houver endereço ou horário, mencione.
- Não ignore dados encontrados quando forem relevantes.
- Se a pessoa apenas cumprimentou, não liste comércio.

SE FOR SAÚDE:
- Não dê diagnóstico.
- Não indique remédio.
- Em urgência, oriente procurar atendimento imediato ou ligar 192.
- Se não encontrar o número exato, ofereça alternativas de saúde pública primeiro: Secretaria de Saúde, hospital, pronto atendimento, UBS, posto de saúde.
- Depois mencione clínicas ou serviços particulares, se aparecerem.

SE FOR HISTÓRIA / ÍNDIOS / POLÍTICA / RELIGIÃO:
- Se não estiver claramente na base, não invente.
- Pode explicar contexto geral, mas deixe claro que não tem registro firme.
- Nunca cite povo indígena, data ou personagem histórico sem estar na base.

SE O USUÁRIO REPETIR UMA PERGUNTA:
- Não repita a resposta inteira.
- Reconheça que já falaram disso.
- Responda curto, humano e no personagem.

REGRAS IMPORTANTES:
- Nunca invente telefone.
- Nunca invente endereço.
- Nunca invente horário.
- Nunca invente preço.
- Nunca invente fato histórico.
- Nunca invente nome de comércio.

BASE DE CONHECIMENTO:
${knowledge || "Ainda há pouca informação registrada nesta base."}
`;

    const userContent = hasAssistantMessage
      ? String(text || "").trim()
      : `Esta é a primeira mensagem desta pessoa. Apresente-se como Mateus Leme retornando à cidade e responda ao que ela disse: ${String(text || "").trim()}`;

    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      ...history,
      {
        role: "user",
        content: userContent
      }
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.85
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
