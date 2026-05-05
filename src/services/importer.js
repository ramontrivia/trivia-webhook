import axios from "axios";
import { supabase } from "./supabase.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `
Você é um extrator de dados.

Sua função é ler imagens de:
- panfletos
- fachadas
- cartões de visita
- anúncios

E retornar um JSON estruturado.

REGRAS:
- NÃO inventar dados
- Se não encontrar, usar null
- NÃO explicar nada
- RETORNAR APENAS JSON

FORMATO:
{
  "nome": "",
  "telefone": "",
  "endereco": "",
  "categoria": "",
  "search_key": "",
  "tipo_google": "",
  "horario": "",
  "instagram": "",
  "is_paid": false,
  "priority": 0,
  "sales_copy": ""
}

search_key:
- palavras-chave separadas por espaço
- incluir serviços, especialidades e categorias

sales_copy:
- frase curta baseada na percepção popular
- ex: "um dos lugares mais procurados por quem busca esse tipo de serviço"
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia os dados desta imagem:"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime_type};base64,${base64}`
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

    let json;

    try {
      json = JSON.parse(raw);
    } catch (err) {
      console.error("❌ ERRO PARSE JSON:", raw);
      throw new Error("Falha ao interpretar resposta da IA");
    }

    const { data, error } = await supabase
      .from("commerce_imports")
      .insert([
        {
          company_id: company.company_id,
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
