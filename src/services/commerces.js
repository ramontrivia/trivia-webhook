export async function searchCommerces({ text, company_id }) {
  try {
    const search = cleanSearchText(text);

    if (!search) return [];

    console.log("BUSCANDO COMERCIOS:", search, "EMPRESA:", company_id);

    let words = search
      .split(" ")
      .filter((word) => word.length >= 3)
      .slice(0, 6);

    if (isHealthIntent(search)) {
      words = [
        ...words,
        "saude",
        "hospital",
        "posto",
        "ubs",
        "secretaria",
        "clinica",
        "medico"
      ];
    }

    words = [...new Set(words)].slice(0, 10);

    if (words.length === 0) return [];

    const filters = words
      .map(
        (word) =>
          `nome.ilike.%${word}%,search_key.ilike.%${word}%,tipo_google.ilike.%${word}%,endereco.ilike.%${word}%`
      )
      .join(",");

    const { data, error } = await supabase
      .from("commerces")
      .select("*")
      .eq("company_id", company_id) // 🔥 ESSA LINHA RESOLVE
      .eq("active", true)
      .or(filters)
      .limit(50);

    if (error) {
      console.error("ERRO AO BUSCAR COMERCIOS:", error);
      return [];
    }

    const results = data || [];

    const sorted = results
      .map((item) => ({
        ...item,
        _score: scoreCommerce(item, text)
      }))
      .filter((item) => item._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10)
      .map(({ _score, ...item }) => item);

    console.log("COMERCIOS ENCONTRADOS:", sorted.length);

    return sorted;

  } catch (err) {
    console.error("ERRO GERAL SEARCH COMMERCES:", err);
    return [];
  }
}
