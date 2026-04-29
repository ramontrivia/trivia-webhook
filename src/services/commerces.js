import { supabase } from "./supabase.js";

function cleanSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchCommerces(text) {
  try {
    const search = cleanSearchText(text);

    if (!search) {
      return [];
    }

    console.log("BUSCANDO COMERCIOS:", search);

    const words = search
      .split(" ")
      .filter((word) => word.length >= 3)
      .slice(0, 5);

    if (words.length === 0) {
      return [];
    }

    let query = supabase
      .from("commerces")
      .select("nome, telefone, endereco, horario, tipo_google, busca_origem, search_key")
      .eq("active", true)
      .limit(20);

    const filters = words
      .map((word) => `nome.ilike.%${word}%,search_key.ilike.%${word}%,tipo_google.ilike.%${word}%,busca_origem.ilike.%${word}%`)
      .join(",");

    query = query.or(filters);

    const { data, error } = await query;

    if (error) {
      console.error("ERRO AO BUSCAR COMERCIOS:", error);
      return [];
    }

    console.log("COMERCIOS ENCONTRADOS:", data?.length || 0);

    return data || [];

  } catch (err) {
    console.error("ERRO GERAL SEARCH COMMERCES:", err);
    return [];
  }
}
