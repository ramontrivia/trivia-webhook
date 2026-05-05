import axios from "axios";
import { supabase } from "./supabase.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function extractJson(raw = "") {
  const text = String(raw || "").trim();

  try {
    return JSON.parse(text);
  } catch {}

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);

  if (match) return JSON.parse(match[0]);

  throw new Error("Falha ao interpretar resposta da IA");
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((v) => {
      if (!v) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object") return Object.values(v).filter(Boolean).join(" ");
      return String(v);
    })
    .filter(Boolean);
}

function buildSearchKey(data = {}) {
  return [
    data.search_key,
    data.nome,
    data.categoria,
    data.tipo_google,
    data.descricao,
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

export async function extractCommerceFromImage({ base64, mime_type, company, from }) {
  try {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

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
Você é um extrator de cadastros locais.

Leia a imagem e extraia somente informações visíveis ou claramente presentes.

Retorne APENAS JSON válido.
Não use markdown.
Não explique.
Não invente telefone, endereço, horário, nome, serviço ou categoria.
Se não encontrar algo, use null ou [].

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

REGRAS:
1. Não criar sinônimos amplos.
2. Não tentar adivinhar intenção futura do usuário.
3. search_key deve conter apenas:
- nome do negócio
- categoria evidente
- palavras realmente visíveis na imagem
- serviços, produtos, especialidades, benefícios, horários e planos visíveis
4. horario deve ser texto legível, nunca objeto.
5. listas devem ser arrays de strings.
6. sales_copy deve ser curta e neutra, sem elogio falso.
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia os dados úteis desta imagem para cadastro local."
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

    const json = extractJson(response.data?.choices?.[0]?.message?.content);

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

    if (error) throw new Error(error.message);

    return { success: true, id: data.id, extracted: json };
  } catch (err) {
    console.error("❌ ERRO IMPORT:", err.message);
    return { success: false, error: err.message };
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

    if (error) throw new Error(error.message);

    if (!imports || imports.length === 0) {
      return { success: false, error: "Nenhuma imagem pendente para finalizar." };
    }

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
Você é um consolidador de cadastros locais.

Una vários JSONs do MESMO cadastro.
Remova duplicidades.
Preserve todos os dados úteis.
Não invente dados.
Não crie sinônimos amplos.
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

Regras:
- horario deve ser texto, nunca objeto.
- listas devem ser arrays de strings.
- search_key deve conter somente termos visíveis ou presentes nos dados consolidados.
- sales_copy deve ser natural, curta e sem elogio falso.
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

    const merged = extractJson(response.data?.choices?.[0]?.message?.content);

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

    if (insertError) throw new Error(insertError.message);

    await supabase
      .from("commerce_imports")
      .update({ status: "used" })
      .in("id", imports.map((i) => i.id));

    return {
      success: true,
      id: readyImport.id,
      extracted: merged,
      count: imports.length
    };
  } catch (err) {
    console.error("❌ ERRO MERGE:", err.message);
    return { success: false, error: err.message };
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

    if (error) throw new Error(error.message);

    if (!ready) {
      return { success: false, error: "Nenhum cadastro pronto para salvar." };
    }

    const d = ready.extracted_data || {};

    const { data: commerce, error: insertError } = await supabase
      .from("commerces")
      .insert([
        {
          company_id: company.company_id || company.id,
          nome: d.nome,
          telefone: d.telefone,
          endereco: buildEndereco(d),
          horario: d.horario,
          tipo_google: d.tipo_google || d.categoria,
          search_key: buildSearchKey(d),
          category: d.categoria,
          active: true,
          is_paid: Boolean(d.is_paid),
          priority: Number(d.priority || 0),
          sales_copy: d.sales_copy
        }
      ])
      .select()
      .single();

    if (insertError) throw new Error(insertError.message);

    await supabase
      .from("commerce_imports")
      .update({ status: "saved" })
      .eq("id", ready.id);

    return { success: true, commerce };
  } catch (err) {
    console.error("❌ ERRO SAVE IMPORT:", err.message);
    return { success: false, error: err.message };
  }
}
