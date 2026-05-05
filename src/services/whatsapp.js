import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";

function graphMessagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

function graphMediaUrl(mediaId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
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

export async function getMediaUrl({ company, mediaId }) {
  try {
    if (!company?.whatsapp_token) {
      throw new Error("whatsapp_token ausente");
    }

    if (!mediaId) {
      throw new Error("mediaId ausente");
    }

    const response = await axios.get(graphMediaUrl(mediaId), {
      headers: {
        Authorization: `Bearer ${company.whatsapp_token}`
      },
      timeout: 20000
    });

    const url = response.data?.url;

    if (!url) {
      throw new Error("URL da mídia não retornada pela Meta");
    }

    console.log("✅ MEDIA URL OK:", {
      mediaId,
      mime_type: response.data?.mime_type
    });

    return {
      url,
      mime_type: response.data?.mime_type,
      sha256: response.data?.sha256,
      file_size: response.data?.file_size,
      id: response.data?.id
    };
  } catch (err) {
    console.error("❌ ERRO AO BUSCAR URL DA MÍDIA:", {
      message: err.message,
      status: err?.response?.status,
      data: err?.response?.data
    });

    throw err;
  }
}

export async function downloadMediaAsBase64({ company, mediaId }) {
  try {
    const media = await getMediaUrl({ company, mediaId });

    const response = await axios.get(media.url, {
      headers: {
        Authorization: `Bearer ${company.whatsapp_token}`
      },
      responseType: "arraybuffer",
      timeout: 30000
    });

    const base64 = Buffer.from(response.data).toString("base64");

    console.log("✅ MEDIA DOWNLOAD OK:", {
      mediaId,
      mime_type: media.mime_type,
      size: media.file_size
    });

    return {
      base64,
      mime_type: media.mime_type || "image/jpeg",
      mediaId,
      url: media.url
    };
  } catch (err) {
    console.error("❌ ERRO AO BAIXAR MÍDIA:", {
      message: err.message,
      status: err?.response?.status,
      data: err?.response?.data
    });

    throw err;
  }
}
