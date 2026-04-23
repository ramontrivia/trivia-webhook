import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Supabase nao configurado.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function safeTrim(v) {
  return String(v || "").trim();
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function getCompanyByPhone(phoneNumberId) {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("phone_number_id", String(phoneNumberId))
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar empresa:", error.message);
    return null;
  }

  return data || null;
}

async function sendTextMessage(company, to, text) {
  const resp = await axios.post(
    graphMessagesUrl(company.phone_number_id),
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
      },
      timeout: 20000
    }
  );

  console.log("SEND OK:", JSON.stringify(resp.data, null, 2));
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("GET /webhook HIT", { mode, tokenReceived: token ? "***" : "" });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificacao do webhook.");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  console.log("POST /webhook HIT");
  console.log("BODY:", JSON.stringify(req.body, null, 2));

  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const status = value?.statuses?.[0];
    const phoneId = safeTrim(value?.metadata?.phone_number_id);

    if (status) {
      console.log("STATUS EVENT:", JSON.stringify(status, null, 2));
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
      phone_number_id: company.phone_number_id
    });

    let reply = "Recebi sua mensagem.";

    if (type === "text" && text) {
      reply = `Recebi sua mensagem: ${text}`;
    } else {
      reply = "Recebi sua mensagem, mas esse tipo ainda nao esta configurado.";
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
