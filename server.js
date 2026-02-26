const express = require("express");
const app = express();

app.use(express.json());

// Health check
app.get("/", (req, res) => res.status(200).send("OK - webhook online"));

// ✅ VERIFICAÇÃO DO WEBHOOK (META CHAMA ISSO NO BOTÃO “Verificar e salvar”)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ✅ RECEBIMENTO DE EVENTOS (mensagens/status etc.)
app.post("/webhook", (req, res) => {
  console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Rodando na porta", PORT));
