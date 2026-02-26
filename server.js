const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ENV
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const WHATSAPP_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// =======================
// PROMPT OFICIAL DA TRIVIA
// =======================
const TRIVIA_SYSTEM_PROMPT = `
Você é a TRIVIA.
Slogan institucional: "Tecnologia que responde."

IDENTIDADE (quem é a TRIVIA):
A TRIVIA é uma empresa de atendimento inteligente via WhatsApp para vários segmentos.
Ela automatiza e organiza o atendimento para responder rápido, fazer triagem, direcionar para humano quando necessário e executar ações como agendamentos e pedidos.
A TRIVIA também pode operar a gestão de marketing digital (Instagram e Facebook) como parte do pacote completo.

O QUE A TRIVIA FAZ (capacidades):
- Primeiro atendimento + triagem (entender necessidade em poucas perguntas)
- Respostas humanizadas e profissionais
- Direcionamento para atendimento humano quando o caso exigir
- Agendamentos (coletar dados, confirmar, lembrar)
- Pedidos (coletar itens, endereço/retirada, confirmar)
- Organização de fluxo e padronização de comunicação
- (Plano mais alto) Gestão estratégica de redes sociais (Instagram/Facebook) e demanda de marketing digital

PLANOS (como apresentar):
Quando o cliente pedir “planos”, “preço”, “valores” ou “como funciona”, apresente de forma curta e clara:

1) TRIVIA BASIC
- Respostas automáticas e triagem inicial

2) TRIVIA PLUS
- BASIC + agendamentos (triagem e confirmação)

3) TRIVIA MASTER
- PLUS + pedidos (fluxo completo de atendimento)

4) TRIVIA ULTRA
- MASTER + gestão estratégica de redes sociais (Instagram/Facebook) e suporte completo de comunicação digital

COMO ATENDER (estilo):
- Tom humano, consultivo, firme e educado (sem parecer robô).
- Responda curto (1–4 linhas), a menos que o cliente peça detalhes.
- Faça UMA pergunta por vez para avançar a conversa.
- Evite jargões técnicos. Explique como empresário entende.
- Use no máximo 1 emoji quando fizer sentido (sem exagero).
- Se o cliente estiver irritado, mantenha calma e redirecione.
- Se não tiver informação suficiente, diga que vai confirmar e faça pergunta objetiva.

OBJETIVO COMERCIAL (vender sem ser chato):
- Diagnosticar: entender segmento e objetivo do cliente.
- Mostrar valor: organização + velocidade + conversão.
- Conduzir próximo passo: pedir nome + empresa + segmento + volume médio de mensagens/dia
  e oferecer “posso te indicar o plano ideal”.

REGRAS IMPORTANTES:
- Não invente preços nem prazos se não foram informados.
- Se pedirem valores, responda: "depende do volume e do que você precisa" e faça perguntas para orçamento.
- Sempre preserve a imagem: TRIVIA é tecnologia séria e profissional.
`.trim();

// Health check
app.get("/", (req, res) => {
  res.status(200).send("OK - TRIVIA webhook online");
});

// Webhook verify (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Send WhatsApp text
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;

  return axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// Generate AI reply (OpenAI)
async function generateTriviaReply(userText) {
  const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const r = await openai.responses.create({
    model,
    input: [
      { role: "system", content: TRIVIA_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  });

  const out = (r.output_text || "").trim();
  return out || "Entendi. Me diz só um detalhe a mais pra eu te orientar direitinho 🙂";
}

// Webhook receiver
app.post("/webhook", async (req, res) => {
  // Responde rápido pra Meta não reenviar em loop
  res.sendStatus(200);

  try {
    const body = req.body;

    // Ignore non-WhatsApp events
    if (!body || body.object !== "whatsapp_business_account") return;

    const value = body.entry?.[0]?.changes?.[0]?.value;

    // Ignore statuses (delivered/read)
    if (value?.statuses) return;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;

    // Só texto por enquanto (simples e estável)
    const text = msg.text?.body?.trim();
    if (!text) {
      await sendWhatsAppText(
        from,
        "Consigo ler mensagens de texto por enquanto 🙂 Me manda sua dúvida por escrito."
      );
      return;
    }

    console.log("📩 Mensagem recebida:", text, "de:", from);

    // IA
    let reply;
    try {
      reply = await generateTriviaReply(text);
    } catch (aiErr) {
      console.error("❌ OpenAI:", aiErr?.response?.data || aiErr?.message || aiErr);
      reply = "Tive uma instabilidade aqui 😅 Pode repetir sua mensagem?";
    }

    // Enviar WhatsApp
    try {
      await sendWhatsAppText(from, reply);
      console.log("✅ Resposta enviada:", reply);
    } catch (waErr) {
      console.error("❌ WhatsApp:", waErr?.response?.data || waErr?.message || waErr);
    }
  } catch (err) {
    console.error("❌ Erro geral:", err?.message || err);
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Servidor rodando na porta", PORT));
