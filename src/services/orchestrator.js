import { sendTextMessage } from "./whatsapp.js";
import { getCompanyByPhoneNumber } from "./companies.js";
import { generateResponse } from "./openai.js";
import { saveMessage } from "./messages.js";

export async function handleIncomingMessage({ body }) {
  try {
    console.log("ORCHESTRATOR START");

    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) {
      console.log("Sem value no payload");
      return;
    }

    const message = value?.messages?.[0];
    const status = value?.statuses?.[0];
    const phoneId = String(value?.metadata?.phone_number_id || "").trim();

    if (status) {
      console.log("STATUS EVENT:", {
        status: status.status,
        recipient_id: status.recipient_id,
        phone_number_id: phoneId,
        errors: status.errors || []
      });
      return;
    }

    if (!message) {
      console.log("Sem mensagem");
      return;
    }

    const from = String(message.from || "").trim();
    const type = String(message.type || "").trim();
    const text = String(message.text?.body || "").trim();

    console.log("Nova mensagem:", {
      from,
      type,
      text,
      phoneId
    });

    const company = await getCompanyByPhoneNumber(phoneId);

    if (!company) {
      console.log("Empresa nao encontrada para phone_number_id:", phoneId);
      return;
    }

    let reply = "Recebi sua mensagem, mas esse tipo ainda nao esta configurado.";

    if (type === "text" && text) {
      await saveMessage({
        companyId: company.id,
        from,
        content: text,
        role: "user"
      });

      reply = await generateResponse({
        text
      });

      await saveMessage({
        companyId: company.id,
        from,
        content: reply,
        role: "assistant"
      });
    }

    await sendTextMessage({
      company,
      to: from,
      text: reply
    });

  } catch (err) {
    console.error("Erro no orchestrator:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
  }
}
