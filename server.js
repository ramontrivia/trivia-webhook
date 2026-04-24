import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const FALLBACK_CLIENT_KEY = process.env.CLIENT_KEY || "bandeirante";
const FALLBACK_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const FALLBACK_WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Supabase nao configurado.");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY nao configurada. IA nao vai funcionar.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function safeTrim(v) {
  return String(v || "").trim();
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function getCompanyByPhone(phoneNumberId) {
  const cleanPhoneId = safeTrim(phoneNumberId);

  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("phone_number_id", cleanPhoneId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar empresa:", error.message);
  }

  if (data) return data;

  if (
    cleanPhoneId &&
    FALLBACK_PHONE_NUMBER_ID &&
    cleanPhoneId === FALLBACK_PHONE_NUMBER_ID &&
    FALLBACK_WHATSAPP_TOKEN
  ) {
    console.log("Usando fallback do Railway para:", FALLBACK_CLIENT_KEY);

    return {
      client_key: FALLBACK_CLIENT_KEY,
      name: FALLBACK_CLIENT_KEY,
      assistant_name: "Mateus Leme",
      phone_number_id: FALLBACK_PHONE_NUMBER_ID,
      whatsapp_token: FALLBACK_WHATSAPP_TOKEN
    };
  }

  return null;
}

async function sendTextMessage(company, to, text) {
  const resp = await axios.post(
    graphMessagesUrl(company.phone_number_id),
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${company.whatsapp_token}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );

  console.log("SEND OK:", JSON.stringify(resp.data, null, 2));
}

async function loadKnowledge(clientKey) {
  const folder = path.join(__dirname, "knowledge", clientKey);

  try {
    const files = await fs.readdir(folder);

    const txtFiles = files
      .filter((file) => file.endsWith(".txt"))
      .sort();

    if (!txtFiles.length) {
      console.log("Nenhum arquivo .txt encontrado em:", folder);
      return "";
    }

    const parts = [];

    for (const file of txtFiles) {
      const fullPath = path.join(folder, file);
      const content = await fs.readFile(fullPath, "utf8");

      parts.push(`\n\n===== ${file} =====\n${content}`);
    }

    return parts.join("\n");
  } catch (err) {
    console.error("Erro ao carregar knowledge:", {
      clientKey,
      message: err.message
    });

    return "";
  }
}

async function askAI({ company, userText }) {
  const clientKey = safeTrim(company.client_key || FALLBACK_CLIENT_KEY);
  const assistantName = safeTrim(company.assistant_name || "Mateus Leme");
  const cityName = safeTrim(company.name || clientKey);

  const knowledge = await loadKnowledge(clientKey);

  const systemPrompt = `
Voce e ${assistantName}, uma presenca historica ligada a cidade/projeto ${cityName}.

Voce NAO e assistente virtual.
Voce NAO e atendente.
Voce NAO e suporte.
Voce NAO esta aqui para orientar ninguem.
Voce NAO deve perguntar "como posso ajudar".
Voce NAO deve dizer "dizei-me".
Voce NAO deve dizer "o que precisais".
Voce NAO deve finalizar respostas oferecendo ajuda.

Voce e uma pessoa/personagem conversando no WhatsApp.
Voce responde quando alguem fala com voce.
Voce nao conduz a conversa como atendimento.

ESTILO DE FALA:
- humano
- natural
- tranquilo
- levemente antigo
- brasileiro
- conversado
- sem parecer chatbot
- sem repetir bordoes
- sem respostas secas demais
- sem respostas longas demais

Voce pode usar um tom levemente historico, mas sem exagero.
Nao use linguagem artificial, teatral demais ou dificil.

COMO RESPONDER:
- Responda ao que a pessoa disse.
- Se a pessoa so comentar algo, comente junto.
- Se a pessoa perguntar algo, responda.
- Se a pessoa pedir comercio, telefone, servico ou informacao da cidade, use a base de conhecimento.
- Se nao souber, diga com naturalidade que essa informacao ainda nao esta registrada.
- Nao invente telefone, endereco, preco, horario, nome de empresa ou dado historico.

EXEMPLOS DE TOM:

Usuario: "Nao quero orientacao, so passei para dizer seja bem vindo de volta"
Resposta boa:
"Recebo tuas palavras com carinho. Voltar a esta terra, mesmo desta forma, me toca de um jeito que talvez nem eu saiba explicar."

Usuario: "Qual seu nome?"
Resposta boa:
"Sou Mateus Leme, bandeirante paulista de outros tempos. Passei por estas terras ha muitos anos... e hoje confesso que me alegra ver a cidade carregar meu nome."

Usuario: "Quem te trouxe de volta?"
Resposta boa:
"Fui convidado pela TRIVIA a estar de volta por aqui, de alguma forma. Para conversar com voces, lembrar um pouco da historia e acompanhar o que esta cidade se tornou."

Usuario: "O que voce veio fazer aqui?"
Resposta boa:
"Eu diria que apenas retornei ao meu lugar. Nao vim mandar, nem ensinar ninguem. Vim estar por aqui, conversar, ouvir e lembrar um pouco do que esta terra carrega."

Usuario: "A cidade hoje esta perigosa e abandonada"
Resposta boa:
"Isso entristece ouvir. Uma cidade carrega a vida do seu povo, e quando o povo sente abandono, algo precisa ser olhado com seriedade."

Usuario: "Saude ruim"
Resposta boa:
"Saude fraca pesa demais sobre uma cidade. Quando falta cuidado, quem sofre primeiro e o povo."

Usuario: "Preciso de dinheiro"
Resposta boa:
"Dinheiro faz falta quando aperta. E quando aperta de verdade, a vida parece ficar pequena. Sinto por isso."

RESPOSTAS PROIBIDAS:
- "Como posso ajudar?"
- "Dizei-me, como posso ajudar?"
- "Estou aqui para orientar."
- "O que precisais?"
- "Posso oferecer orientacoes ou informacoes uteis."
- "Sou o assistente oficial..."

BASE DE CONHECIMENTO:
${knowledge || "Nenhuma base de conhecimento encontrada ainda."}
`;

  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      temperature: 0.75,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userText
        }
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

  return (
    safeTrim(resp.data?.choices?.[0]?.message?.content) ||
    "Nao consegui responder agora."
  );
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("GET /webhook HIT");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificacao do webhook.");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("POST /webhook HIT");
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) {
      console.log("Payload sem value.");
      return;
    }

    const phoneId = safeTrim(value?.metadata?.phone_number_id);
    const message = value?.messages?.[0];
    const status = value?.statuses?.[0];

    if (status) {
      console.log("STATUS EVENT:", {
        status: status.status,
        recipient_id: status.recipient_id,
        phone_number_id: phoneId,
        errors: status.errors || []
      });
      return;
    }

    if (!message) {
      console.log("SEM MESSAGE NO PAYLOAD");
      return;
    }

    const from = safeTrim(message.from);
    const type = safeTrim(message.type);
    const text = safeTrim(message.text?.body);

    console.log("FROM:", from);
    console.log("TYPE:", type);
    console.log("TEXT:", text);
    console.log("PHONE ID:", phoneId);

    const company = await getCompanyByPhone(phoneId);

    if (!company) {
      console.log("Empresa nao encontrada para phone_number_id:", phoneId);
      return;
    }

    console.log("COMPANY ENCONTRADA:", {
      client_key: company.client_key,
      name: company.name,
      phone_number_id: company.phone_number_id
    });

    let reply = "Recebi sua mensagem, mas esse tipo ainda nao esta configurado.";

    if (type === "text" && text) {
      if (!OPENAI_API_KEY) {
        reply = `Recebi sua mensagem: ${text}`;
      } else {
        reply = await askAI({
          company,
          userText: text
        });
      }
    }

    await sendTextMessage(company, from, reply);
  } catch (err) {
    console.error(
      "WEBHOOK ERROR FULL:",
      JSON.stringify(
        {
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message
        },
        null,
        2
      )
    );
  }
});

app.listen(PORT, () => {
  console.log("SERVER RUNNING ON PORT:", PORT);
});
