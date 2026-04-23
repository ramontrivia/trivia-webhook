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

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let companiesCache = [];

function safeTrim(v) {
  return String(v || "").trim();
}

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

async function loadCompanies() {
  const { data, error } = await supabase.from("companies").select("*");

  if (error) {
    console.error("Erro ao carregar companies:", error.message);
    companiesCache = [];
    return;
  }

  companiesCache = (data || []).filter(
    (c) =>
      safeTrim(c.client_key) &&
      safeTrim(c.phone_number_id) &&
      safeTrim(c.whatsapp_token)
  );

  console.log("Companies carregadas:", companiesCache.length);
  console.log(
    companiesCache.map((c) => ({
      client_key: c.client_key,
      phone_number_id: c.phone_number_id
    }))
  );
}

function getCompanyByPhone(phoneNumberId) {
  return companiesCache.find(
    (c) => String(c.phone_number_id) === String(phoneNumberId)
  );
}

async function sendMessage(company, to, text) {
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

  console.log("SEND OK:", resp.data);
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const status = value?.statuses?.[0];

    if (status) {
      console.log("STATUS EVENT:", {
        status: status.status,
        recipient_id: status.recipient_id,
        phone_number_id: value?.metadata?.phone_number_id,
        errors: status.errors || []
      });
    }

    if (!message) {
      console.log("Sem message no payload");
      return;
    }

    const from = message.from;
    const text = safeTrim(message.text?.body);
    const phoneId = value?.metadata?.phone_number_id;

    console.log("FROM:", from);
    console.log("TEXT:", text);
    console.log("PHONE ID:", phoneId);

    const company = getCompanyByPhone(phoneId);

    if (!company) {
      console.log("Empresa nao encontrada para phone_number_id:", phoneId);
      return;
    }

    await sendMessage(company, from, `Recebi sua mensagem: ${text}`);
  } catch (err) {
    console.error(
      "WEBHOOK ERROR:",
      err?.response?.status,
      err?.response?.data || err.message
    );
  }
});

async function start() {
  if (!supabase) {
    console.error("Supabase nao configurado.");
    process.exit(1);
  }

  await loadCompanies();

  app.listen(PORT, () => {
    console.log("SERVER MINIMO RUNNING");
  });
}

start();
