import express from "express";
import { handleIncomingMessage } from "../services/orchestrator.js";

const router = express.Router();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";

// GET continua igual
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

// POST atualizado
router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  await handleIncomingMessage({
    body: req.body
  });
});

export default router;
