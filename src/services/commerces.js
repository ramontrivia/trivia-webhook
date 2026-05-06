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

function getSearchWords(text) {
  const stopWords = new Set([
    "preciso",
    "precisa",
    "quero",
    "queria",
    "gostaria",
    "procuro",
    "procurando",
    "tem",
    "teria",
    "algum",
    "alguma",
    "alguem",
    "alguém",
    "voce",
    "você",
    "pode",
    "me",
    "um",
    "uma",
    "uns",
    "umas",
    "de",
    "do",
    "da",
    "dos",
    "das",
    "no",
    "na",
    "nos",
    "nas",
    "com",
    "para",
    "por",
    "que",
    "onde",
    "qual",
    "telefone",
    "numero",
    "número",
    "contato"
  ]);

  return cleanSearchText(text)
    .split(" ")
    .filter((word) => word.length >= 3)
    .filter((word) => !stopWords.has(word))
    .slice(0, 8);
}

function isHealthIntent(text) {
  const search = cleanSearchText(text);

  const terms = [
    "saude",
    "posto",
    "ubs",
    "upa",
    "hospital",
    "pronto atendimento",
    "medico",
    "medica",
    "consulta",
    "clinica",
    "dentista",
    "psicologo",
    "psicologa",
    "vacina",
    "exame",
    "laboratorio",
    "farmacia",
    "remedio"
  ];

  return terms.some((term) => search.includes(term));
}

function scoreCommerce(item, words, healthIntent) {
  const text = cleanSearchText(
    [
      item.nome,
      item.telefone,
      item.endereco,
      item.horario,
      item.tipo_google,
      item.busca_origem,
      item.search_key,
      item.category
    ].join(" ")
  );

  let score = 0;

  for (const word of words) {
    if (text.includes(word)) {
      score += 10;
    }
  }

  if (score <= 0) {
    return 0;
  }

  if (healthIntent) {
    const publicHealthPriority = [
      "secretaria",
      "hospital",
      "ubs",
      "posto",
      "saude",
      "unidade",
      "centro de saude",
      "saude mental"
    ];

    for (const term of publicHealthPriority) {
      if (text.includes(term)) {
        score += 5;
      }
    }
  }

  if (item.is_paid) {
    score += 20;
  }

  if (item.priority) {
    score += Number(item.priority) || 0;
  }

  return score;
}

export async function searchCommerces({ text, company_id }) {
  try {
    const search = cleanSearchText(text);

    if (!search) return [];

    if (!company_id) {
      console.warn("BUSCA CANCELADA: company_id ausente");
      return [];
    }

    const words = getSearchWords(text);

    if (words.length === 0) {
      console.log("BUSCA CANCELADA: sem termos úteis", search);
      return [];
    }

    const healthIntent = isHealthIntent(search);

    let searchWords = [...words];

    if (healthIntent) {
      searchWords = [
        ...searchWords,
        "saude",
        "hospital",
        "posto",
        "ubs",
        "secretaria",
        "clinica",
        "medico"
      ];
    }

    searchWords = [...new Set(searchWords)].slice(0, 12);

    console.log("BUSCANDO COMERCIOS:", {
      search,
      words: searchWords,
      company_id
    });

    const filters = searchWords
      .map(
        (word) =>
          `nome.ilike.%${word}%,search_key.ilike.%${word}%,tipo_google.ilike.%${word}%,busca_origem.ilike.%${word}%,endereco.ilike.%${word}%,category.ilike.%${word}%`
      )
      .join(",");

    const { data, error } = await supabase
      .from("commerces")
      .select("*")
      .eq("company_id", company_id)
      .eq("active", true)
      .or(filters)
      .limit(50);

    if (error) {
      console.error("ERRO AO BUSCAR COMERCIOS:", {
        message: error.message,
        details: error.details,
        code: error.code
      });
      return [];
    }

    const results = data || [];

    const sorted = results
      .map((item) => ({
        ...item,
        _score: scoreCommerce(item, words, healthIntent)
      }))
      .filter((item) => item._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10)
      .map(({ _score, ...item }) => item);

    console.log("COMERCIOS ENCONTRADOS:", sorted.length);

    return sorted;
  } catch (err) {
    console.error("ERRO GERAL SEARCH COMMERCES:", err.message);
    return [];
  }
}
