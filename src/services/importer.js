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

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .filter(Boolean);
}

function buildSearchKey(data = {}) {
  return [
    data.search_key,
    data.nome,
    data.categoria,
    data.tipo_google,
    ...normalizeArray(data.beneficios),
    ...normalizeArray(data.servicos),
    ...normalizeArray(data.especialidades),
    ...normalizeArray(data.exames),
    ...normalizeArray(data.procedimentos),
    ...normalizeArray(data.planos)
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

export async function extractCommerceFromImage({
  base64,
  mime_type,
  company,
  from
}) {
  try {
    console.log("🧠 LENDO IMAGEM COM IA...");

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
Você é um extrator inteligente de dados comerciais.

Leia qualquer tipo de imagem:
- panfleto
- fachada
- cartão
- anúncio
- conversa com informações

Retorne APENAS JSON válido.

Formato:
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

REGRAS:

1. Categoria simples:
saude, beleza, restaurante, servicos, comercio, igreja, educacao

2. search_key (CRÍTICO):
Gere palavras que representam:
- o que é
- o que vende
- como procuram
- problemas que resolve

Exemplos:
pedreiro → pedreiro obra reforma construção parede reboco piso telhado vazamento
salão → salão cabelo corte escova unha manicure estética beleza
pet → pet cachorro gato banho tosa ração veterinário
igreja → igreja culto oração bíblia fé religioso

Use linguagem popular.

3. NÃO inventar dados.

4. Se não tiver, usar null.

5. horario:
SEMPRE retornar texto legível.
Ex:
"terça 19:30 | quinta oração 19:00 | domingo 19:00"
NUNCA retornar objeto.

6. sales_copy:
Frase forte e natural:
"Um nome bastante lembrado por quem busca este tipo de serviço."
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia todos os dados desta imagem."
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
    const json = extractJson(raw);

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

    if (error) throw new Error(error.message);

    return {
      success: true,
      id: data.id,
      extracted: json
    };
  } catch (err) {
    console.error("❌ ERRO IMPORT:", err.message);
    return { success: false, error: err.message };
  }
}

export async function mergePendingCommerceImports({ company, from }) {
  try {
    const { data: imports } = await supabase
      .from("commerce_imports")
      .select("*")
      .eq("company_id", company.company_id)
      .eq("admin_phone", from)
      .eq("status", "pending");

    const partials = imports.map((i) => i.extracted_data);

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
Una vários JSONs do MESMO negócio.

- remover duplicados
- unir listas
- completar dados

horario → texto legível
listas → arrays de strings

retorne JSON válido
`
          },
          {
            role: "user",
            content: JSON.stringify(partials)
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const merged = extractJson(
      response.data?.choices?.[0]?.message?.content
    );

    const { data } = await supabase
      .from("commerce_imports")
      .insert([
        {
          company_id: company.company_id,
          client_key: company.client_key,
          admin_phone: from,
          extracted_data: merged,
          status: "ready"
        }
      ])
      .select()
      .single();

    await supabase
      .from("commerce_imports")
      .update({ status: "used" })
      .in("id", imports.map((i) => i.id));

    return { success: true, extracted: merged };
  } catch (err) {
    console.error("❌ ERRO MERGE:", err.message);
    return { success: false };
  }
}

export async function saveReadyImportToCommerces({ company, from }) {
  try {
    const { data: ready } = await supabase
      .from("commerce_imports")
      .select("*")
      .eq("company_id", company.company_id)
      .eq("admin_phone", from)
      .eq("status", "ready")
      .limit(1)
      .single();

    const d = ready.extracted_data;

    const { data: commerce } = await supabase
      .from("commerces")
      .insert([
        {
          company_id: company.company_id,
          nome: d.nome,
          telefone: d.telefone,
          endereco: buildEndereco(d),
          horario: d.horario,
          tipo_google: d.tipo_google,
          search_key: buildSearchKey(d),
          category: d.categoria,
          active: true,
          is_paid: d.is_paid || false,
          priority: d.priority || 0,
          sales_copy: d.sales_copy
        }
      ])
      .select()
      .single();

    await supabase
      .from("commerce_imports")
      .update({ status: "saved" })
      .eq("id", ready.id);

    return { success: true, commerce };
  } catch (err) {
    console.error("❌ ERRO SAVE:", err.message);
    return { success: false };
  }
}
