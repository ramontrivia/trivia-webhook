import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

export async function sendTextMessage({ company, to, message, text }) {
  try {
    const bodyText = text || message;

    if (!company?.phone_number_id) {
      throw new Error("phone_number_id ausente");
    }

    if (!company?.whatsapp_token) {
      throw new Error("whatsapp_token ausente");
    }

    if (!to || !bodyText) {
      throw new Error("to ou mensagem ausente");
    }

    const response = await axios.post(
      graphMessagesUrl(company.phone_number_id),
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body: bodyText
        }
      },
      {
        headers: {
          Authorization: `Bearer ${company.whatsapp_token}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    console.log("✅ WHATSAPP OK:", response.data);

    return response.data;

  } catch (err) {
    console.error("❌ ERRO WHATSAPP:", {
      message: err.message,
      status: err?.response?.status,
      data: err?.response?.data
    });

    throw err;
  }
}
