const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "trivia123"; // mesmo token que você colocar na Meta

// Verificação do webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// Receber mensagens
app.post("/webhook", (req, res) => {
  console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

app.get("/", (req, res) => res.status(200).send("OK - webhook online"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Rodando na porta", PORT));
