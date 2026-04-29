import { sendTextMessage } from "./whatsapp.js";
import { getCompanyByPhoneNumber } from "./companies.js";
import { generateResponse } from "./openai.js";
import { saveMessage } from "./messages.js";
import { searchCommerces } from "./commerces.js";

const inactivityTimers = new Map();

function cleanText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimpleConversation(text) {
  const search = cleanText(text);

  const simpleMessages = [
    "oi",
    "ola",
    "olá",
    "opa",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "tudo bom",
    "beleza",
    "blz",
    "ok",
    "certo",
    "sim",
    "nao",
    "não",
    "obrigado",
    "obrigada",
    "valeu"
  ];

  return simpleMessages.includes(search);
}

function getSimpleConversationReply(text) {
  const search = cleanText(text);

  if (search === "boa noite") {
    return "Boa noite, boa alma. Que a noite lhe seja serena por estas bandas. Sigo por aqui, recolhendo notícias da cidade e pronto para uma boa prosa.";
  }

  if (search === "bom dia") {
    return "Bom dia, boa alma. Que o dia lhe venha manso e de boa serventia. Diga-me, se precisar de alguma notícia destas terras.";
  }

  if (search === "boa tarde") {
    return "Boa tarde, nobre pessoa. Sigo por estas bandas, com minha agenda em mãos, recolhendo nomes, telefones e histórias da cidade.";
  }

  return "Saudações, boa alma. Sigo por aqui, nesta caminhada por Mateus Leme, pronto para uma boa prosa e para lhe ajudar com informações da cidade.";
}

function shouldSearchCommerces(text) {
  const search = cleanText(text);

  if (!search) return false;
  if (isSimpleConversation(search)) return false;

  const usefulTerms = [
    "telefone",
    "numero",
    "número",
    "contato",
    "endereco",
    "endereço",
    "horario",
    "horário",
    "onde",
    "tem",
    "procuro",
    "preciso",
    "quero",
    "comercio",
    "comércio",
    "loja",
    "farmacia",
    "farmácia",
    "saude",
    "saúde",
    "posto",
    "ubs",
    "hospital",
    "clinica",
    "clínica",
    "medico",
    "médico",
    "dentista",
    "escola",
    "mercado",
    "supermercado",
    "padaria",
    "oficina",
    "mecanica",
    "mecânica",
    "auto",
    "roupa",
    "moda",
    "pizzaria",
    "restaurante",
    "lanchonete",
    "barbearia",
    "salao",
    "salão",
    "academia",
    "racao",
    "ração",
    "pet",
    "veterinaria",
    "veterinária",
    "construcao",
    "construção",
    "eletricista",
    "advogado",
    "cartorio",
    "cartório",
    "prefeitura"
  ];

  return usefulTerms.some((term) => search.includes(cleanText(term)));
}

function clearInactivityTimer(from) {
  const existingTimer = inactivityTimers.get(from);

  if (existingTimer) {
    clearTimeout(existingTimer);
    inactivityTimers.delete(from);
  }
}

function scheduleInactivityMessage({ company, from }) {
  clearInactivityTimer(from);

  const timer = setTimeout(async () => {
    try {
      const message =
        "Foi bom ver vosmecê por aqui. Agora sigo minha caminhada, recolhendo informações para deixar tudo bem guardado em minha agenda. Minha função nestas terras é ajudar com telefones de comércios, horários de funcionamento, serviços da cidade e, claro, bater uma boa prosa quando precisares.";

      await saveMessage({
        company,
        from,
        content: message,
        role: "assistant"
      });

      await sendTextMessage({
        company,
        to: from,
        text: message
      });

      console.log("MENSAGEM DE INATIVIDADE ENVIADA:", from);
      inactivityTimers.delete(from);
    } catch (err) {
      console.error("ERRO AO ENVIAR MENSAGEM DE INATIVIDADE:", {
        message: err?.message,
        status: err?.response?.status,
        data: err?.response?.data
      });
    }
  }, 5 * 60 * 1000);

  inactivityTimers.set(from, timer);
}

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

    clearInactivityTimer(from);

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
        "Ora pois… por enquanto ainda não consigo ouvir áudio nessas engenhocas modernas. Mande-me por escrito, que hei de lhe responder melhor.";

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

      scheduleInactivityMessage({ company, from });

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

      if (isSimpleConversation(text)) {
        reply = getSimpleConversationReply(text);

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

        scheduleInactivityMessage({ company, from });

        console.log("RESPOSTA SIMPLES ENVIADA SEM BUSCAR COMERCIO");
        return;
      }

      let context = "";

      if (shouldSearchCommerces(text)) {
        const commerces = await searchCommerces(text);

        if (commerces.length > 0) {
          const list = commerces
            .slice(0, 10)
            .map((c) => {
              const parts = [];

              if (c.nome) parts.push(c.nome);
              if (c.telefone) parts.push(`Tel: ${c.telefone}`);
              if (c.endereco) parts.push(`Endereço: ${c.endereco}`);
              if (c.horario) parts.push(`Horário: ${c.horario}`);

              return `- ${parts.join(" — ")}`;
            })
            .join("\n");

          context = `
INFORMAÇÕES ENCONTRADAS NA CIDADE:
${list}

Use essas informações somente se tiverem relação direta com a pergunta da pessoa.
Não use lista se a pessoa apenas cumprimentou.
Não use markdown.
Não use títulos.
Liste as opções de forma clara e simples.
          `;
        }
      } else {
        console.log("BUSCA DE COMERCIOS IGNORADA PARA:", text);
      }

      const finalText = context ? `${text}\n\n${context}` : text;

      reply = await generateResponse({
        text: finalText,
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

      scheduleInactivityMessage({ company, from });

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
      "Ora pois… esse tipo de mensagem ainda não consigo entender por aqui. Se puder, mande-me por escrito, que hei de lhe responder melhor.";

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

    scheduleInactivityMessage({ company, from });

    console.log("TIPO NAO SUPORTADO:", type);

  } catch (err) {
    console.error("ERRO ORCHESTRATOR:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
  }
}      });

      console.log("MENSAGEM DE INATIVIDADE ENVIADA:", from);
      inactivityTimers.delete(from);
    } catch (err) {
      console.error("ERRO AO ENVIAR MENSAGEM DE INATIVIDADE:", {
        message: err?.message,
        status: err?.response?.status,
        data: err?.response?.data
      });
    }
  }, 5 * 60 * 1000);

  inactivityTimers.set(from, timer);
}

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

    clearInactivityTimer(from);

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

      scheduleInactivityMessage({ company, from });

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

      const commerces = await searchCommerces(text);

      let context = "";

      if (commerces.length > 0) {
        const list = commerces
          .slice(0, 10)
          .map((c) => {
            const parts = [];

            if (c.nome) parts.push(c.nome);
            if (c.telefone) parts.push(`Tel: ${c.telefone}`);
            if (c.endereco) parts.push(`Endereço: ${c.endereco}`);
            if (c.horario) parts.push(`Horário: ${c.horario}`);

            return `- ${parts.join(" — ")}`;
          })
          .join("\n");

        context = `
INFORMAÇÕES ENCONTRADAS NA CIDADE:
${list}

Use essas informações na resposta se fizer sentido.
Liste as opções encontradas de forma clara e organizada.
        `;
      }

      reply = await generateResponse({
        text: `${text}\n\n${context}`,
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

      scheduleInactivityMessage({ company, from });

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

    scheduleInactivityMessage({ company, from });

    console.log("TIPO NAO SUPORTADO:", type);

  } catch (err) {
    console.error("ERRO ORCHESTRATOR:", {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data
    });
  }
}
