import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

export async function sendTextMessage({ company, to, text }) {
  const response = await axios.post(
    graphMessagesUrl(company.phone_number_id),
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: text
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

  console.log("WHATSAPP SEND OK:", JSON.stringify(response.data, null, 2));

  return response.data;
}
