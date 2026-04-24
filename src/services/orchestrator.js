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
      console.log("STATUS EVENT:", status);
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

    console.log("Empresa encontrada:", {
      id: company.id,
      client_key: company.client_key,
      name: company.name
    });

    let reply = "Recebi sua mensagem, mas esse tipo ainda nao esta configurado.";

    if (type === "text" && text) {
      await saveMessage({
        company,
        from,
        content: text,
        role: "user"
      });

      reply = await generateResponse({
        text
      });

      await saveMessage({
        company,
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

    console.log("Resposta enviada com sucesso");

  } catch (err) {
    console.error("ERRO GERAL ORCHESTRATOR:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
  }
}
