import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function graphUrl(phoneId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
}

// 🔎 Busca empresa
async function getCompany(phoneId) {
  const { data } = await supabase
    .from("companies")
    .select("*")
    .eq("phone_number_id", phoneId)
    .maybeSingle();

  return data;
}

// 💾 salva mensagem
async function saveMessage(client_key, from, message, role) {
  await supabase.from("messages").insert({
    client_key,
    from_number: from,
    message,
    role
  });
}

// 🧠 IA (OpenAI)
async function askAI(history, message) {
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é a Mel, uma atendente estratégica, humana e objetiva. Fale de forma natural, uma pergunta por vez, foco em entender o cliente e levar à decisão."
        },
        ...history,
        { role: "user", content: message }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  return resp.data.choices[0].message.content;
}

// 📤 envia mensagem
async function sendMessage(company, to, text) {
  await axios.post(
    graphUrl(company.phone_number_id),
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${company.whatsapp_token}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// 🔁 webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const phoneId = value?.metadata?.phone_number_id;
    const from = message.from;
    const text = message.text?.body || "";

    console.log("MSG:", text);

    const company = await getCompany(phoneId);
    if (!company) return;

    // salva usuário
    await saveMessage(company.client_key, from, text, "user");

    // busca histórico
    const { data: history } = await supabase
      .from("messages")
      .select("message, role")
      .eq("client_key", company.client_key)
      .eq("from_number", from)
      .order("created_at", { ascending: true })
      .limit(10);

    const formattedHistory = (history || []).map((m) => ({
      role: m.role,
      content: m.message
    }));

    // IA responde
    const aiResponse = await askAI(formattedHistory, text);

    // salva resposta
    await saveMessage(company.client_key, from, aiResponse, "assistant");

    // envia
    await sendMessage(company, from, aiResponse);
  } catch (err) {
    console.error("ERROR:", err?.response?.data || err.message);
  }
});

// verificação meta
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.listen(PORT, () => {
  console.log("🚀 TRIVIA BOT RODANDO");
});
