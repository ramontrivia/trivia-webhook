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

function normalizeText(value) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          return Object.entries(item)
            .map(([key, val]) => `${key}: ${val}`)
            .join(" / ");
        }

        return String(item);
      })
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${val}`)
      .join(" / ");
  }

  return String(value).trim() || null;
}

function arrayToText(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(", ");
  }

  return normalizeText(value);
}

function buildSearchKey(data = {}) {
  return [
    data.search_key,
    data.nome,
    data.categoria,
    data.subcategoria,
    data.tipo_google,
    data.descricao,
    arrayToText(data.enderecos),
    arrayToText(data.beneficios),
    arrayToText(data.servicos),
    arrayToText(data.especialidades),
    arrayToText(data.produtos),
    arrayToText(data.exames),
    arrayToText(data.procedimentos),
    arrayToText(data.planos),
    arrayToText(data.horarios),
    arrayToText(data.programacao),
    arrayToText(data.observacoes),
    arrayToText(data.palavras_chave)
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEndereco(data = {}) {
  if (Array.isArray(data.enderecos) && data.enderecos.length > 0) {
    return data.enderecos
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(" | ");
  }

  return normalizeText(data.endereco);
}

function buildHorario(data = {}) {
  const horarioParts = [
    normalizeText(data.horario),
    arrayToText(data.horarios),
    arrayToText(data.programacao)
  ].filter(Boolean);

  return horarioParts.join(" | ") || null;
}

function buildDescricao(data = {}) {
  return [
    data.descricao,
    data.resumo,
    arrayToText(data.beneficios),
    arrayToText(data.servicos),
    arrayToText(data.especialidades),
    arrayToText(data.produtos),
    arrayToText(data.exames),
    arrayToText(data.procedimentos),
    arrayToText(data.planos),
    arrayToText(data.programacao),
    arrayToText(data.observacoes)
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .join(" | ");
}

function normalizeCategory(value) {
  const text = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (!text) return "servicos";

  if (text.includes("saude") || text.includes("medic") || text.includes("clinica")) {
    return "saude";
  }

  if (text.includes("igreja") || text.includes("relig")) {
    return "religiao";
  }

  if (text.includes("salao") || text.includes("beleza") || text.includes("barbear")) {
    return "beleza";
  }

  if (text.includes("restaurante") || text.includes("pizza") || text.includes("lanche") || text.includes("comida")) {
    return "alimentacao";
  }

  if (text.includes("pet")) {
    return "pet";
  }

  if (text.includes("escola") || text.includes("educa")) {
    return "educacao";
  }

  if (text.includes("loja") || text.includes("comercio") || text.includes("mercado")) {
    return "comercio";
  }

  return text.replace(/\s+/g, "_");
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
Você é um extrator universal de cadastros locais.

Você deve ler imagens de:
- panfletos
- fachadas
- cartões de visita
- banners
- prints de conversas
- listas de horários
- cardápios
- tabelas de serviços
- igrejas
- salões
- clínicas
- restaurantes
- lojas
- profissionais autônomos
- pet shops
- escolas
- oficinas
- prestadores de serviço
- instituições

Retorne APENAS JSON válido.
Não use markdown.
Não explique.
Não invente dados.
Se não encontrar uma informação, use null ou [].

IMPORTANTE:
- Extraia TUDO que estiver visível.
- Preserve horários, dias da semana, programas, cultos, aulas, planos, preços, serviços, especialidades, exames e observações.
- Se aparecer uma igreja, trate como cadastro local, não como comércio comum.
- Se aparecer um print de conversa com informações úteis, extraia os dados como cadastro.
- Se houver texto histórico sem fonte oficial, coloque em "observacoes", não trate como fato absoluto.
- Não invente telefone, endereço, preço, horário ou história.

Formato obrigatório:
{
  "nome": null,
  "telefone": null,
  "telefones": [],
  "endereco": null,
  "enderecos": [],
  "bairro": null,
  "cidade": null,
  "estado": null,
  "categoria": null,
  "subcategoria": null,
  "tipo_google": null,
  "horario": null,
  "horarios": [],
  "programacao": [],
  "instagram": null,
  "site": null,
  "email": null,
  "descricao": null,
  "resumo": null,
  "beneficios": [],
  "servicos": [],
  "especialidades": [],
  "produtos": [],
  "exames": [],
  "procedimentos": [],
  "planos": [],
  "precos": [],
  "formas_pagamento": [],
  "observacoes": [],
  "palavras_chave": [],
  "search_key": null,
  "is_paid": false,
  "priority": 0,
  "sales_copy": null
}

Regras para categoria:
- Use categorias curtas e normalizadas:
  saude, alimentacao, beleza, comercio, servicos, religiao, pet, educacao, automotivo, construcao, lazer, evento, instituicao.
- Se não souber, use "servicos".

Regras para programação/horários:
- Se houver dia + horário, coloque em "programacao".
- Exemplo:
  { "dia": "terça-feira", "atividade": "culto", "horario": "19:30" }

Regras para planos:
- Se houver plano, preço ou assinatura, coloque em "planos".
- Exemplo:
  { "nome": "Individual", "preco": "R$ 19,90 por mês", "descricao": "1 titular com todos os benefícios" }

Regras para sales_copy:
- Crie uma frase curta, natural e forte.
- Use ideia de destaque ou procura frequente sem mentir.
- Não diga "o melhor", "todo mundo gosta" ou avaliações falsas.
`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extraia todos os dados úteis desta imagem para um cadastro local pesquisável."
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
      throw new Error(error.message);
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
    console.log("🔄 CONSOLIDANDO IMPORTAÇÕES...");

    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada");
    }

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
Você é um consolidador universal de cadastros locais.

Você receberá vários JSONs extraídos de imagens diferentes do MESMO cadastro.

Sua função:
- juntar tudo em UM cadastro final
- remover duplicidades
- preservar dados úteis
- completar listas
- não inventar dados
- não transformar informações genéricas da internet em fato local se não estiverem no material
- corrigir categorias para padrão normalizado
- preservar horários como objetos legíveis
- preservar cultos, programação, planos, benefícios, serviços, especialidades, exames, produtos e procedimentos

Retorne APENAS JSON válido.
Não use markdown.
Não explique.

Formato obrigatório:
{
  "nome": null,
  "telefone": null,
  "telefones": [],
  "endereco": null,
  "enderecos": [],
  "bairro": null,
  "cidade": null,
  "estado": null,
  "categoria": null,
  "subcategoria": null,
  "tipo_google": null,
  "horario": null,
  "horarios": [],
  "programacao": [],
  "instagram": null,
  "site": null,
  "email": null,
  "descricao": null,
  "resumo": null,
  "beneficios": [],
  "servicos": [],
  "especialidades": [],
  "produtos": [],
  "exames": [],
  "procedimentos": [],
  "planos": [],
  "precos": [],
  "formas_pagamento": [],
  "observacoes": [],
  "palavras_chave": [],
  "search_key": null,
  "is_paid": false,
  "priority": 0,
  "sales_copy": null
}

Regras:
- Se um campo vier como objeto, preserve como objeto.
- Se houver vários horários, coloque em "programacao" ou "horarios".
- Se houver "bairro Suzana n 976", transforme em endereço/bairro quando possível.
- Se houver cultos, oração, estudo bíblico, coloque em "programacao".
- Para igrejas, categoria = "religiao".
- Para saúde, categoria = "saude".
- Para salão/barbearia, categoria = "beleza".
- Para pedreiro/construção, categoria = "construcao".
- Para restaurante/pizzaria/lanche, categoria = "alimentacao".
- Para pet shop, categoria = "pet".
- "search_key" deve ser completo e conter nome, categoria, bairro, cidade, serviços, programação, especialidades, produtos e termos alternativos.
- "sales_copy" deve ser curta e natural, sem avaliações falsas.
`
          },
          {
            role: "user",
            content: `Una estes dados em um único cadastro final, preservando o máximo de informação útil:\n${JSON.stringify(partials, null, 2)}`
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

    merged.categoria = normalizeCategory(merged.categoria);
    merged.search_key = buildSearchKey(merged);

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
    const horario = buildHorario(data);
    const searchKey = buildSearchKey(data);
    const descricao = buildDescricao(data);
    const category = normalizeCategory(data.categoria);

    const { data: commerce, error: insertError } = await supabase
      .from("commerces")
      .insert([
        {
          company_id: company.company_id || company.id,
          nome: data.nome,
          telefone: data.telefone || arrayToText(data.telefones),
          endereco,
          horario,
          tipo_google: data.tipo_google || data.subcategoria || category,
          search_key: searchKey,
          category,
          active: true,
          is_paid: Boolean(data.is_paid),
          priority: Number(data.priority || 0),
          sales_copy: data.sales_copy || null,

          especialidades: arrayToText(data.especialidades),
          exames: arrayToText(data.exames),
          procedimentos: arrayToText(data.procedimentos),
          beneficios: arrayToText(data.beneficios),
          planos: arrayToText(data.planos),
          descricao
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
