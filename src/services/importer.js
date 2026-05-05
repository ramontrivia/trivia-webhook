import axios from "axios";
import { supabase } from "./supabase.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function extractJson(raw = "") {
  const text = String(raw || "").trim();

  try {
    return JSON.parse(text);
  } catch {}

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);

  if (match) {
    return JSON.parse(match[0]);
  }

  throw new Error("Falha ao interpretar resposta da IA");
}

export async function extractCommerceFromImage({
  base64,
  mime_type,
  company,
  from
}) {
  try {
    console.log("🧠 LENDO IMAGEM COM IA...");

    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada");
    }

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é um extrator de dados de imagens comerciais.

Leia panfletos, fachadas, cartões de visita, banners, placas e materiais de divulgação.

Retorne APENAS um JSON válido.

Não use markdown.
Não explique.
Não invente dados.
Se não encontrar uma informação, use null.

Formato obrigatório:
{
  "nome": null,
  "telefone": null,
  "endereco": null,
  "categoria": null,
  "search_key": null,
  "tipo_google": null,
  "horario": null,
  "instagram": null,
  "descricao": null,
  "servicos": [],
  "especialidades": [],
  "planos": [],
  "is_paid": false,
  "priority": 0,
  "sales_copy": null
}

Regras:
- "search_key" deve conter palavras-chave úteis para busca.
- "categoria" deve ser curta, exemplo: saude, restaurante, beleza, comercio, servicos.
- "sales_copy" deve ser natural, forte e curta, sem inventar avaliações falsas.
- Extraia listas de especialidades, exames, procedimentos e planos quando aparecerem.
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia os dados comerciais desta imagem e retorne somente JSON válido."
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime_type || "image/jpeg"};base64,${base64}`
                }
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content;

    console.log("📦 RESPOSTA IA:", raw);

    const json = extractJson(raw);

    const { data, error } = await supabase
      .from("commerce_imports")
      .insert([
        {
          company_id: company.company_id || company.id,
          client_key: company.client_key,
          admin_phone: from,
          extracted_data: json,
          status: "pending"
        }
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ ERRO AO SALVAR IMPORT:", error);
      throw new Error("Erro ao salvar prévia");
    }

    console.log("✅ IMPORT SALVO:", data.id);

    return {
      success: true,
      id: data.id,
      extracted: json
    };
  } catch (err) {
    console.error("❌ ERRO IMPORTER:", err.message);

    return {
      success: false,
      error: err.message
    };
  }
}
