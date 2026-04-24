import { supabase } from "./supabase.js";

export async function getConversationHistory({ company, from, limit = 10 }) {
  try {
    console.log("BUSCANDO HISTÓRICO:", {
      company: company?.id,
      from
    });

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("company", company?.id)
      .eq("user_phone", from)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("ERRO AO BUSCAR HISTÓRICO:", error);
      return [];
    }

    console.log("HISTÓRICO ENCONTRADO:", data);

    if (!data || data.length === 0) {
      console.log("⚠️ HISTÓRICO VAZIO");
      return [];
    }

    return data
      .reverse()
      .map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.message
      }));

  } catch (err) {
    console.error("ERRO GERAL HISTÓRICO:", err);
    return [];
  }
}
