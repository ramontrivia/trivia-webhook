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

function arrayToText(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }

  return value || null;
}

function buildSearchKey(data = {}) {
  return [
    data.search_key,
    data.nome,
    data.categoria,
    data.tipo_google,
    arrayToText(data.beneficios),
    arrayToText(data.servicos),
    arrayToText(data.especialidades),
    arrayToText(data.exames),
    arrayToText(data.procedimentos),
    arrayToText(data.planos)
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEndereco(data = {}) {
  if (Array.isArray(data.enderecos) && data.enderecos.length > 0) {
    return data.enderecos.filter(Boolean).join(" | ");
  }

  return data.endereco || null;
}

export async function resetPendingImports({ company, from }) {
  await supabase
    .from("commerce_imports")
    .update({ status: "cancelled" })
    .eq("company_id", company.company_id || company.id)
    .eq("client_key", company.client_key)
    .eq("admin_phone", from)
    .in("status", ["pending", "ready"]);

  return true;
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

Retorne APENAS JSON válido.
Não use markdown.
Não explique.
Não invente dados.
Se não encontrar uma informação, use null.

Formato obrigatório:
{
  "nome": null,
  "telefone": null,
  "endereco": null,
  "enderecos": [],
  "categoria": null,
  "search_key": null,
  "tipo_google": null,
  "horario": null,
  "instagram": null,
  "descricao": null,
  "beneficios": [],
  "servicos": [],
  "especialidades": [],
  "exames": [],
  "procedimentos": [],
  "planos": [],
  "is_paid": false,
  "priority": 0,
  "sales_copy": null
}

Regras:
- Extraia tudo que estiver visível.
- "categoria" deve ser curta: saude, restaurante, beleza, comercio, servicos.
- "search_key" deve conter palavras úteis para busca.
- "sales_copy" deve ser curta, natural e forte, sem inventar avaliação falsa.
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia os dados comerciais desta imagem."
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

export async function mergePendingCommerceImports({ company, from }) {
  try {
    const { data: imports, error } = await supabase
      .from("commerce_imports")
      .select("id, extracted_data, created_at")
      .eq("company_id", company.company_id || company.id)
      .eq("client_key", company.client_key)
      .eq("admin_phone", from)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    if (!imports || imports.length === 0) {
      return {
        success: false,
        error: "Nenhuma imagem pendente para finalizar."
      };
    }

    const partials = imports.map((item) => item.extracted_data);

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
Você é um consolidador de cadastros comerciais.

Você receberá vários JSONs extraídos de imagens diferentes do MESMO negócio.

Sua função:
- juntar tudo em UM cadastro final
- remover duplicidades
- completar listas
- preservar telefone, endereços, planos, benefícios, especialidades, exames e procedimentos
- não inventar dados
- se não souber, use null ou []

Retorne APENAS JSON válido.

Formato obrigatório:
{
  "nome": null,
  "telefone": null,
  "endereco": null,
  "enderecos": [],
  "categoria": null,
  "search_key": null,
  "tipo_google": null,
  "horario": null,
  "instagram": null,
  "descricao": null,
  "beneficios": [],
  "servicos": [],
  "especialidades": [],
  "exames": [],
  "procedimentos": [],
  "planos": [],
  "is_paid": false,
  "priority": 0,
  "sales_copy": null
}

sales_copy:
- frase forte e natural
- usar ideia de "nome bastante procurado/lembrado em minha agenda"
- não dizer "o melhor", "todo mundo gosta" ou avaliação falsa.
`
          },
          {
            role: "user",
            content: `Una estes dados em um único cadastro final:\n${JSON.stringify(partials, null, 2)}`
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
    console.log("📦 CADASTRO CONSOLIDADO IA:", raw);

    const merged = extractJson(raw);

    const { data: readyImport, error: insertError } = await supabase
      .from("commerce_imports")
      .insert([
        {
          company_id: company.company_id || company.id,
          client_key: company.client_key,
          admin_phone: from,
          extracted_data: merged,
          status: "ready"
        }
      ])
      .select()
      .single();

    if (insertError) {
      throw new Error(insertError.message);
    }

    await supabase
      .from("commerce_imports")
      .update({ status: "used" })
      .in("id", imports.map((item) => item.id));

    return {
      success: true,
      id: readyImport.id,
      extracted: merged,
      count: imports.length
    };
  } catch (err) {
    console.error("❌ ERRO MERGE IMPORTS:", err.message);

    return {
      success: false,
      error: err.message
    };
  }
}

export async function saveReadyImportToCommerces({ company, from }) {
  try {
    const { data: ready, error } = await supabase
      .from("commerce_imports")
      .select("*")
      .eq("company_id", company.company_id || company.id)
      .eq("client_key", company.client_key)
      .eq("admin_phone", from)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!ready) {
      return {
        success: false,
        error: "Nenhum cadastro pronto para salvar."
      };
    }

    const data = ready.extracted_data || {};

    const endereco = buildEndereco(data);
    const searchKey = buildSearchKey(data);

    const { data: commerce, error: insertError } = await supabase
      .from("commerces")
      .insert([
        {
          company_id: company.company_id || company.id,
          nome: data.nome,
          telefone: data.telefone,
          endereco,
          horario: data.horario,
          tipo_google: data.tipo_google || data.categoria,
          search_key: searchKey,
          category: data.categoria,
          active: true,
          is_paid: Boolean(data.is_paid),
          priority: Number(data.priority || 0),
          sales_copy: data.sales_copy
        }
      ])
      .select()
      .single();

    if (insertError) {
      throw new Error(insertError.message);
    }

    await supabase
      .from("commerce_imports")
      .update({ status: "saved" })
      .eq("id", ready.id);

    return {
      success: true,
      commerce
    };
  } catch (err) {
    console.error("❌ ERRO SALVAR COMMERCE:", err.message);

    return {
      success: false,
      error: err.message
    };
  }
}
