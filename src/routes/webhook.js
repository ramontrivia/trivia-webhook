import express from "express";
import { handleIncomingMessage } from "../services/orchestrator.js";

const router = express.Router();

router.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK POST RECEBIDO");

  res.sendStatus(200);

  try {
    await handleIncomingMessage(req.body);
  } catch (error) {
    console.error("ERRO AO PROCESSAR WEBHOOK:", error);
  }
});

export default router;
