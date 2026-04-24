import express from "express";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";

// Verificação do Meta
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("GET /webhook HIT");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificacao do webhook.");
  return res.sendStatus(403);
});

// Recebimento (ainda simples)
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  console.log("POST /webhook HIT");
  console.log("BODY:", JSON.stringify(req.body, null, 2));
});

export default router;
