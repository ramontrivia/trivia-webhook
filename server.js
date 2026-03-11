import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===============================
ENV
=============================== */

const PORT = process.env.PORT || 8080;
const GRAPH_VERSION = "v21.0";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ===============================
CACHE DE EMPRESAS
=============================== */

let EMPRESAS = [];

async function carregarEmpresas() {

  const { data, error } = await supabase
    .from("companies")
    .select("*");

  if (error) {
    console.log("❌ erro Supabase:", error.message);
    return;
  }

  console.log("📦 Linhas brutas do Supabase:", data.length);

  EMPRESAS = data.map(e => ({
    id: e.id,
    name: e.name,
    phoneNumberId: String(e.phone_number_id),
    token: e.whatsapp_token
  }));

  console.log("📦 Empresas mapeadas:", EMPRESAS);

  console.log("✅ Empresas válidas:", EMPRESAS.length);
}

function getEmpresa(phoneNumberId){

  return EMPRESAS.find(
    e => e.phoneNumberId === String(phoneNumberId)
  );

}

/* ===============================
OPENAI
=============================== */

async function gerarResposta(msg){

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      messages: [
        { role: "user", content: msg }
      ]
    },
    {
      headers:{
        Authorization:`Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  return response.data.choices[0].message.content;

}

/* ===============================
ENVIAR WHATSAPP
=============================== */

async function enviarMensagem(empresa,to,text){

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${empresa.phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product:"whatsapp",
      to:to,
      type:"text",
      text:{ body:text }
    },
    {
      headers:{
        Authorization:`Bearer ${empresa.token}`,
        "Content-Type":"application/json"
      }
    }
  );

}

/* ===============================
WEBHOOK VERIFY
=============================== */

app.get("/webhook",(req,res)=>{

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if(mode && token === VERIFY_TOKEN){
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);

});

/* ===============================
WEBHOOK MESSAGES
=============================== */

app.post("/webhook", async (req,res)=>{

  try{

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];

    if(!message){
      return res.sendStatus(200);
    }

    const phoneNumberId = value.metadata.phone_number_id;
    const from = message.from;
    const text = message.text?.body;

    console.log(`📩 msg recebida | phone_number_id=${phoneNumberId}`);

    const empresa = getEmpresa(phoneNumberId);

    if(!empresa){

      console.log("⚠ empresa não encontrada:", phoneNumberId);

      return res.sendStatus(200);
    }

    const resposta = await gerarResposta(text);

    await enviarMensagem(empresa,from,resposta);

    res.sendStatus(200);

  }catch(err){

    console.log("❌ erro webhook:",err.message);

    res.sendStatus(200);

  }

});

/* ===============================
START SERVER
=============================== */

app.listen(PORT, async ()=>{

  console.log("🚀 servidor iniciando...");

  await carregarEmpresas();

  console.log(`✅ servidor rodando porta ${PORT}`);

});
