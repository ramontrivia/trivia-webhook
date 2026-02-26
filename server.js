import express from "express";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "trivia_verify_2026";

// GET para verificação do Webhook (Meta chama isso)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST para receber eventos (por enquanto só responde 200)
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

app.get("/", (req, res) => res.status(200).send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on port", port));