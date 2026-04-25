import { sendTextMessage } from "./whatsapp.js";
import { getCompanyByPhoneNumber } from "./companies.js";
import { generateResponse } from "./openai.js";
import { saveMessage } from "./messages.js";

export async function handleIncomingMessage({ body }) {
  try {
    console.log("ORCHESTRATOR START");

    const value = body?.entry?.[0]?.changes?.[0]?.value;

    if (!value) {
      console.log("SEM VALUE");
      return;
    }

    const message = value?.messages?.[0];
    const status = value?.statuses?.[0];
    const phoneId = String(value?.metadata?.phone_number_id || "").trim();

    if (status) {
      console.log("STATUS EVENT:", status.status);
      return;
    }

    if (!message) {
      console.log("SEM MENSAGEM");
      return;
    }

    const from = String(message.from || "").trim();
    const type = String(message.type || "").trim();
    const text = String(message.text?.body || "").trim();

    console.log("MENSAGEM RECEBIDA:", {
      from,
      type,
      text,
      phoneId
    });

    const company = await getCompanyByPhoneNumber(phoneId);

    if (!company) {
      console.log("EMPRESA NAO ENCONTRADA:", phoneId);
      return;
    }

    console.log("EMPRESA ENCONTRADA:", {
      id: company.id,
      client_key: company.client_key,
      name: company.name
    });

    let reply = "";

    if (type === "audio") {
      const audioNotice = "[Áudio recebido - ainda não processado]";

      await saveMessage({
        company,
        from,
        content: audioNotice,
        role: "user"
      });

      reply =
        "Ô meu amigo… por ora ainda não consigo ouvir áudio nessas engenhocas modernas. " +
        "Me mande por escrito, que aí consigo te responder melhor.";

      await saveMessage({
        company,
        from,
        content: reply,
        role: "assistant"
      });

      await sendTextMessage({
        company,
        to: from,
        text: reply
      });

      console.log("ÁUDIO RECEBIDO - RESPOSTA PADRAO ENVIADA");
      return;
    }

    if (type === "text" && text) {
      await saveMessage({
        company,
        from,
        content: text,
        role: "user"
      });

      reply = await generateResponse({
        text,
        company,
        from
      });

      await saveMessage({
        company,
        from,
        content: reply,
        role: "assistant"
      });

      await sendTextMessage({
        company,
        to: from,
        text: reply
      });

      console.log("RESPOSTA ENVIADA");
      return;
    }

    const unsupportedNotice = `[Mensagem recebida do tipo ${type} - ainda não processada]`;

    await saveMessage({
      company,
      from,
      content: unsupportedNotice,
      role: "user"
    });

    reply =
      "Ô meu amigo… esse tipo de mensagem ainda não consigo entender por aqui. " +
      "Se puder, me mande por escrito, que eu lhe respondo melhor.";

    await saveMessage({
      company,
      from,
      content: reply,
      role: "assistant"
    });

    await sendTextMessage({
      company,
      to: from,
      text: reply
    });

    console.log("TIPO NAO SUPORTADO:", type);

  } catch (err) {
    console.error("ERRO ORCHESTRATOR:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
  }
}
