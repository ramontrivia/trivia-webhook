// TRIVIA WEBHOOK MULTI CLIENTES
// WhatsApp Cloud API + Supabase + OpenAI

import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GRAPH_VERSION = "v21.0";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const COMMERCIAL_PHONE = (process.env.COMMERCIAL_PHONE || "").replace(/\D/g,"");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let COMPANIES_CACHE = [];

function makeCompanyKey(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]/g,"_");
}

async function loadCompanies() {

  const { data, error } = await supabase
  .from("Empresas")
  .select("*");

  if(error){
    console.log("❌ erro supabase:",error.message);
    return;
  }

  COMPANIES_CACHE = data.map(row => ({
    id: row.id,
    name: row.Nome,
    key: makeCompanyKey(row.Nome),
    phoneNumberId: String(row.phone_number_id),
    token: row.whatsapp_token
  }));

  console.log("✅ empresas carregadas:",COMPANIES_CACHE.length);

}

function findCompanyByPhoneId(id){

  return COMPANIES_CACHE.find(
    c => String(c.phoneNumberId) === String(id)
  );

}

function graphUrl(phoneId){
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
}

async function sendWhatsApp(client,to,text){

  const payload={
    messaging_product:"whatsapp",
    to,
    type:"text",
    text:{body:text}
  };

  await axios.post(
    graphUrl(client.phoneNumberId),
    payload,
    {
      headers:{
        Authorization:`Bearer ${client.token}`,
        "Content-Type":"application/json"
      }
    }
  );

}

async function askGPT(message){

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model:OPENAI_MODEL,
      messages:[
        {
          role:"system",
          content:"Você é MEL, atendente da TRIVIA. Responda curto e humano."
        },
        {
          role:"user",
          content:message
        }
      ]
    },
    {
      headers:{
        Authorization:`Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  return res.data.choices[0].message.content;

}

app.get("/",(req,res)=>{

  res.send("TRIVIA webhook online");

});

app.get("/webhook",(req,res)=>{

  const mode=req.query["hub.mode"];
  const token=req.query["hub.verify_token"];
  const challenge=req.query["hub.challenge"];

  if(mode==="subscribe" && token===VERIFY_TOKEN){

    console.log("✅ webhook verificado");
    return res.status(200).send(challenge);

  }

  res.sendStatus(403);

});

app.post("/webhook",async(req,res)=>{

  res.sendStatus(200);

  try{

    const entry=req.body.entry?.[0];
    const changes=entry?.changes?.[0];
    const value=changes?.value;

    const msg=value?.messages?.[0];
    if(!msg) return;

    const from=msg.from;
    const text=msg.text?.body;

    const phoneId=value.metadata.phone_number_id;

    const company=findCompanyByPhoneId(phoneId);

    if(!company){

      console.log("⚠️ empresa não encontrada:",phoneId);
      return;

    }

    console.log("📩 mensagem de",from,"cliente",company.name);

    if(COMMERCIAL_PHONE && from===COMMERCIAL_PHONE) return;

    const reply = await askGPT(text);

    await sendWhatsApp(company,from,reply);

  }catch(err){

    console.log("❌ erro webhook",err.message);

  }

});

async function start(){

  await loadCompanies();

  app.listen(PORT,()=>{

    console.log("🚀 servidor rodando porta",PORT);

  });

}

start();
