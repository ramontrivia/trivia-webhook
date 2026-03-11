// server.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
ENV
========================= */

const PORT = process.env.PORT || 8080

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0"

const VERIFY_TOKEN = process.env.VERIFY_TOKEN

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || "")

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

const PHONE_NUMBER_ID_BUSCAI = process.env.PHONE_NUMBER_ID_BUSCAI
const WHATSAPP_TOKEN_BUSCAI = process.env.WHATSAPP_TOKEN_BUSCAI

const supabase =
SUPABASE_URL && SUPABASE_KEY
? createClient(SUPABASE_URL, SUPABASE_KEY)
: null

/* =========================
UTIL
========================= */

function normalizePhone(raw) {
if (!raw) return ""
return String(raw).replace(/[^\d]/g, "")
}

function safeTrim(v) {
return String(v || "").trim()
}

function makeCompanyKey(name) {
return String(name || "")
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "")
.toLowerCase()
.replace(/[^a-z0-9]+/g, "_")
.replace(/^_+|_+$/g, "")
}

/* =========================
COMPANIES CACHE
========================= */

let COMPANIES_CACHE = []

function getLegacyCompanies() {

const companies = []

if (PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
companies.push({
name: "TRIVIA",
key: "trivia",
phoneNumberId: PHONE_NUMBER_ID,
token: WHATSAPP_TOKEN
})
}

if (PHONE_NUMBER_ID_BUSCAI && WHATSAPP_TOKEN_BUSCAI) {
companies.push({
name: "BUSCA AI",
key: "cliente_buscai",
phoneNumberId: PHONE_NUMBER_ID_BUSCAI,
token: WHATSAPP_TOKEN_BUSCAI
})
}

return companies

}

async function loadCompaniesFromSupabase() {

if (!supabase) return []

const { data } = await supabase
.from("companies")
.select("*")

if (!data) return []

return data.map(row => ({
name: safeTrim(row.name),
key: makeCompanyKey(row.name),
phoneNumberId: safeTrim(row.phone_number_id),
token: safeTrim(row.whatsapp_token)
}))

}

async function refreshCompaniesCache() {

const db = await loadCompaniesFromSupabase()

if (db.length) {
COMPANIES_CACHE = db
console.log("Empresas carregadas do Supabase:", db.length)
return
}

COMPANIES_CACHE = getLegacyCompanies()

console.log("Fallback legado:", COMPANIES_CACHE.length)

}

function getCompanyByPhoneNumberId(id) {

return COMPANIES_CACHE.find(
c => safeTrim(c.phoneNumberId) === safeTrim(id)
)

}

/* =========================
KNOWLEDGE TXT
========================= */

function listTxtFilesFlat(dir) {

if (!fs.existsSync(dir)) return []

return fs.readdirSync(dir)
.filter(f => f.endsWith(".txt"))
.map(f => path.join(dir, f))

}

function getKnowledgeDirs(clientKey) {

if (clientKey === "trivia")
return [path.join(process.cwd(), "knowledge")]

if (clientKey === "cliente_buscai")
return [path.join(process.cwd(), "knowledge", "cliente_buscai")]

return [path.join(process.cwd(), "knowledge")]

}

function loadKnowledgeForClient(clientKey) {

const dirs = getKnowledgeDirs(clientKey)

const files = []

dirs.forEach(dir => {
files.push(...listTxtFilesFlat(dir))
})

if (!files.length) {
console.log("Nenhum TXT encontrado para", clientKey)
return ""
}

const parts = []

files.forEach(full => {

const file = path.basename(full)

const content = fs.readFileSync(full, "utf8")

parts.push(`

CLIENTE: ${clientKey}
ARQUIVO: ${file}

${content}

`)

})

console.log("Knowledge carregado", clientKey, files.length)

return parts.join("\n")

}

const KNOWLEDGE_CACHE = new Map()

function getKnowledge(clientKey) {

if (!KNOWLEDGE_CACHE.has(clientKey)) {
KNOWLEDGE_CACHE.set(
clientKey,
loadKnowledgeForClient(clientKey)
)
}

return KNOWLEDGE_CACHE.get(clientKey)

}

/* =========================
SESSIONS
========================= */

const sessions = new Map()

function getSession(clientKey, user) {

const key = `${clientKey}:${user}`

if (!sessions.has(key)) {

sessions.set(key, {
history: [],
leadNotified: false
})

}

return sessions.get(key)

}

function pushHistory(session, role, text) {

session.history.push({ role, text })

if (session.history.length > 40)
session.history.shift()

}

/* =========================
WHATSAPP
========================= */

function graphMessagesUrl(phoneNumberId) {
return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`
}

async function sendWhatsAppText(clientKey, to, body) {

const company = COMPANIES_CACHE.find(c => c.key === clientKey)

const payload = {
messaging_product: "whatsapp",
to,
type: "text",
text: { body }
}

await axios.post(
graphMessagesUrl(company.phoneNumberId),
payload,
{
headers: {
Authorization: `Bearer ${company.token}`,
"Content-Type": "application/json"
}
}
)

}

/* =========================
OPENAI
========================= */

async function generateAssistantReply(clientKey, session, userText) {

const KNOWLEDGE_BASE = getKnowledge(clientKey)

const assistantName =
clientKey === "cliente_buscai"
? "Beatrice"
: "MEL"

const companyName =
clientKey === "cliente_buscai"
? "Busca Aí"
: "TRÍVIA"

const system = `

Você é ${assistantName}, atendente oficial da ${companyName} no WhatsApp.

PERSONA
Humana, simpática, clara e objetiva.

REGRAS ABSOLUTAS

Todas as respostas devem usar a BASE DE CONHECIMENTO abaixo.

Se houver links oficiais na base você deve enviar os links.

Você nunca deve dizer que não pode enviar links.

Você nunca deve dizer que não consegue fornecer links.

Se o usuário pedir baixar, download, instalar ou aplicativo, você deve procurar os links oficiais na base e enviá-los.

Nunca invente links.

Nunca invente números ou informações.

Nunca fale de código ou sistema interno.

BASE DE CONHECIMENTO

${KNOWLEDGE_BASE}

`.trim()

const messages = [

{ role: "system", content: system },

...session.history.map(m => ({
role: m.role,
content: m.text
})),

{ role: "user", content: userText }

]

const res = await axios.post(
"https://api.openai.com/v1/chat/completions",
{
model: OPENAI_MODEL,
messages,
temperature: 0.4,
max_tokens: 300
},
{
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
"Content-Type": "application/json"
}
}
)

return res.data.choices[0].message.content

}

/* =========================
WEBHOOK
========================= */

app.get("/", (req,res)=>res.send("OK"))

app.get("/webhook",(req,res)=>{

const mode = req.query["hub.mode"]
const token = req.query["hub.verify_token"]
const challenge = req.query["hub.challenge"]

if(mode==="subscribe" && token===VERIFY_TOKEN)
return res.status(200).send(challenge)

res.sendStatus(403)

})

app.post("/webhook", async (req,res)=>{

res.sendStatus(200)

try{

const entry = req.body.entry?.[0]
const changes = entry?.changes?.[0]
const value = changes?.value

const msg = value?.messages?.[0]

if(!msg) return

const from = msg.from
const text = msg.text?.body

const phoneId = value.metadata.phone_number_id

const company = getCompanyByPhoneNumberId(phoneId)

if(!company){
console.log("empresa não encontrada", phoneId)
return
}

const clientKey = company.key

const session = getSession(clientKey, from)

pushHistory(session,"user",text)

const reply = await generateAssistantReply(
clientKey,
session,
text
)

await sendWhatsAppText(clientKey, from, reply)

pushHistory(session,"assistant",reply)

}catch(err){

console.log("erro webhook", err.message)

}

})

/* =========================
START
========================= */

async function start(){

await refreshCompaniesCache()

app.listen(PORT,()=>{
console.log("Servidor rodando", PORT)
})

}

start()
