import { sendTextMessage } from "./whatsapp.js";

export async function handleIncomingMessage({ body }) {
  try {
    console.log("ORCHESTRATOR START");

    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) {
      console.log("Sem value no payload");
      return;
    }

    const message = value?.messages?.[0];
    const phoneId = value?.metadata?.phone_number_id;

    if (!message) {
      console.log("Sem mensagem");
      return;
    }

    const from = message.from;
    const text = message.text?.body;

    console.log("Nova mensagem:", {
      from,
      text,
      phoneId
    });

    // ⚠️ TEMPORÁRIO (teste)
    const fakeCompany = {
      phone_number_id: phoneId,
      whatsapp_token: process.env.WHATSAPP_TOKEN
    };

    const reply = `Recebi: ${text}`;

    await sendTextMessage({
      company: fakeCompany,
      to: from,
      text: reply
    });

  } catch (err) {
    console.error("Erro no orchestrator:", err.message);
  }
}
