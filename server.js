// server.js (ESM) — funciona com package.json: { "type": "module" }

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV obrigatórias (Railway Variables):
 * - PORT (Railway define)
 * - VERIFY_TOKEN
 * - WHATSAPP_TOKEN
 * - PHONE_NUMBER_ID
 * - GRAPH_VERSION  -> use "v21.0" (v minúsculo!)
 * - COMMERCIAL_PHONE (ex: 5531997373954)
 * - (opcional) KNOWLEDGE_PATH (default: knowledge/trivia_base.txt)
 */

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const GRAPH_VERSION_RAW = process.env.GRAPH_VERSION || "v21.0";
const COMMERCIAL_PHONE = process.env.COMMERCIAL_PHONE || "";

// Normaliza GRAPH_VERSION (garante "v" minúsculo)
const GRAPH_VERSION = (() => {
  const v = String(GRAPH_VERSION_RAW).trim();
  if (!v) return "v21.0";
  // se vier "V21.0", vira "v21.0"
  if (v[0] === "V") return "v" + v.slice(1);
  return v;
})();

const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KNOWLEDGE_PATH =
  process.env.KNOWLEDGE_PATH ||
  path.join(__dirname, "knowledge", "trivia_base.txt");

// Base carregada (texto longo)
let KNOWLEDGE_TEXT = "";

// Sessões simples em memória (não perde em deploy? perde, mas ok pra MVP)
const sessions = new Map(); // wa_id -> { stage, company, city, lastIntent }

/** =======================
 * Helpers
 * ======================= */

function logEnvSafe() {
  const mask = (s) => (s ? `${String(s).slice(0, 6)}...${String(s).slice(-4)}` : "");
  console.log("PORT:", PORT);
  console.log("GRAPH_VERSION:", GRAPH_VERSION);
  console.log("PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? mask(PHONE_NUMBER_ID) : "(vazio)");
  console.log("WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? mask(WHATSAPP_TOKEN) : "(vazio)");
  console.log("VERIFY_TOKEN:", VERIFY_TOKEN ? "(ok)" : "(vazio)");
  console.log("COMMERCIAL_PHONE:", COMMERCIAL_PHONE || "(vazio)");
}

function normalizeText(t) {
  return String(t || "").trim();
}

function isHireIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return (
    t.includes("contratar") ||
    t.includes("quero contratar") ||
    t.includes("fechar") ||
    t.includes("assinar") ||
    t.includes("plano") ||
    t.includes("orçamento") ||
    t.includes("orcamento") ||
    t.includes("comercial")
  );
}

function isJustCommercialContact(text) {
  const t = normalizeText(text).toLowerCase();
  // Cliente pedindo só o telefone/contato
  return (
    t.includes("telefone do comercial") ||
    t.includes("quero telefone do comercial") ||
    t.includes("me passa o telefone") ||
    t.includes("me passa o contato") ||
    t.includes("contato do comercial") ||
    t === "telefone" ||
    t === "contato"
  );
}

function extractCompanyAndCity(text) {
  // Extrator simples (não perfeito) – pega algo tipo:
  // "Salão Chanel. De Mateus Leme minas gerais"
  const raw = normalizeText(text);

  // tentativa de achar "de <cidade>" ou "<cidade> - <uf>"
  const cityMatch =
    raw.match(/\bde\s+([A-Za-zÀ-ÿ\s]{3,})(?:\s*-\s*([A-Za-z]{2}))?\b/i) ||
    raw.match(/\b([A-Za-zÀ-ÿ\s]{3,})\s*-\s*([A-Za-z]{2})\b/i);

  const city = cityMatch ? normalizeText(cityMatch[1] + (cityMatch[2] ? `-${cityMatch[2]}` : "")) : "";

  // empresa: pega antes de "de ..." se existir; senão a primeira frase
  let company = "";
  const parts = raw.split(".");
  if (parts.length >= 1) company = normalizeText(parts[0]);
  if (company.toLowerCase().startsWith("de ")) company = company.slice(3).trim();

  // Se a “empresa” ficou igual à cidade, limpa
  if (city && company && company.toLowerCase() === city.toLowerCase()) company = "";

  return { company, city };
}

async function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      KNOWLEDGE_TEXT = fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
      console.log(`✅ Base carregada (${path.relative(__dirname, KNOWLEDGE_PATH)})`);
    } else {
      KNOWLEDGE_TEXT = "";
      console.log(`⚠️ Base NÃO encontrada em ${KNOWLEDGE_PATH} (ok, sigo sem base)`);
    }
  } catch (err) {
    KNOWLEDGE_TEXT = "";
    console.log("⚠️ Falha ao carregar base:", err?.message || err);
  }
}

async function sendWhatsAppText(to, body) {
  const url = `${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`;

  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    };

    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    return { ok: true, data: res.data };
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log("❌ WhatsApp send error", status, JSON.stringify(data || err?.message || err));
    return { ok: false, status, data };
  }
}

async function notifyCommercialLead({ from, company, city, lastUserText }) {
  if (!COMMERCIAL_PHONE) return;

  const msg =
    `📩 *Novo lead TRÍVIA*\n` +
    `Cliente: ${from}\n` +
    (company ? `Empresa: ${company}\n` : "") +
    (city ? `Cidade/UF: ${city}\n` : "") +
    `Mensagem: ${lastUserText}`;

  // tenta avisar o comercial (pode falhar se o número não aceitar/sem janela)
  await sendWhatsAppText(COMMERCIAL_PHONE, msg);
}

function commercialMessage() {
  // Mensagem ultra profissional e direta
  const phone = COMMERCIAL_PHONE || "—";
  return (
    `Perfeito. Vou te passar o contato do nosso comercial agora.\n\n` +
    `📞 *Comercial TRÍVIA (WhatsApp)*: ${phone}\n` +
    `Se preferir, me diga seu nome e melhor horário que o time te chama.`
  );
}

/** =======================
 * Rotas
 * ======================= */

app.get("/", (req, res) => res.status(200).send("TRÍVIA webhook online ✅"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    graph_version: GRAPH_VERSION,
    has_phone_number_id: Boolean(PHONE_NUMBER_ID),
    has_whatsapp_token: Boolean(WHATSAPP_TOKEN),
    has_verify_token: Boolean(VERIFY_TOKEN),
    has_commercial_phone: Boolean(COMMERCIAL_PHONE),
    knowledge_loaded: Boolean(KNOWLEDGE_TEXT)
  });
});

// Verificação do webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado.");
    return res.status(200).send(challenge);
  }

  console.log("❌ Falha verificação webhook.");
  return res.sendStatus(403);
});

// Recebe mensagens
app.post("/webhook", async (req, res) => {
  // IMPORTANTE: responde 200 rápido pra Meta não reenviar
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || !messages.length) return;

    const msg = messages[0];
    const from = msg.from; // wa_id do cliente
    const text = msg?.text?.body ? normalizeText(msg.text.body) : "";

    if (!from || !text) return;

    // pega sessão
    const sess = sessions.get(from) || { stage: "default", company: "", city: "", lastIntent: "" };

    // 1) intenção: só quer o telefone do comercial
    if (isJustCommercialContact(text)) {
      sess.stage = "handoff_done";
      sess.lastIntent = "commercial_contact";
      sessions.set(from, sess);

      await sendWhatsAppText(from, commercialMessage());
      await notifyCommercialLead({ from, company: sess.company, city: sess.city, lastUserText: text });
      return;
    }

    // 2) intenção: contratar
    if (isHireIntent(text)) {
      sess.lastIntent = "hire";
      sessions.set(from, sess);

      // se a pessoa só diz “quero contratar”, não vamos enrolar:
      // pedimos dados UMA vez, mas se ela insistir, a gente entrega o contato.
      if (!sess.company || !sess.city) {
        // tenta extrair do texto atual
        const extracted = extractCompanyAndCity(text);
        if (extracted.company && !sess.company) sess.company = extracted.company;
        if (extracted.city && !sess.city) sess.city = extracted.city;

        sessions.set(from, sess);

        // Se ainda não tem dados, pede de forma curtíssima.
        if (!sess.company || !sess.city) {
          await sendWhatsAppText(
            from,
            "Perfeito. Pra eu direcionar certinho pro comercial: *nome da empresa* e *cidade/UF*?"
          );
          return;
        }
      }

      // Já tem dados -> entrega contato e notifica comercial
      await sendWhatsAppText(from, commercialMessage());
      await notifyCommercialLead({ from, company: sess.company, city: sess.city, lastUserText: text });
      sess.stage = "handoff_done";
      sessions.set(from, sess);
      return;
    }

    // 3) Se o cliente respondeu com empresa/cidade enquanto estava no fluxo de contratar
    if (sess.lastIntent === "hire" && (text.length >= 3)) {
      const extracted = extractCompanyAndCity(text);
      if (extracted.company && !sess.company) sess.company = extracted.company;
      if (extracted.city && !sess.city) sess.city = extracted.city;

      sessions.set(from, sess);

      // Se ele já passou algo, não enrola: já manda o comercial.
      if (sess.company || sess.city) {
        await sendWhatsAppText(from, commercialMessage());
        await notifyCommercialLead({ from, company: sess.company, city: sess.city, lastUserText: text });
        sess.stage = "handoff_done";
        sessions.set(from, sess);
        return;
      }
    }

    // 4) Conversa normal (resposta simples, sem travar)
    // (Aqui você pode plugar OpenAI depois. Por enquanto: resposta objetiva e profissional.)
    await sendWhatsAppText(
      from,
      "Entendi. Me diz rapidinho: você quer *agendar*, *pedidos/orçamentos* ou *organizar o atendimento* no WhatsApp?"
    );
  } catch (err) {
    console.log("❌ Webhook handler error:", err?.message || err);
    // como já respondemos 200 pra Meta, não precisa fazer nada aqui
  }
});

/** =======================
 * Start
 * ======================= */

await loadKnowledge();
logEnvSafe();

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
