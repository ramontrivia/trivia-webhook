import { supabase } from "./supabase.js";

export async function getConversationHistory({ company, from, limit = 10 }) {
  try {
    console.log("BUSCANDO HISTORICO:", {
      company_id: company?.id,
      from
    });

    const { data, error } = await supabase
      .from("messages")
      .select("message, role, created_at")
      .eq("company_id", company?.id)
      .eq("user_phone", from)
      .not("message", "is", null)
      .not("role", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("ERRO AO BUSCAR HISTORICO:", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });

      return [];
    }

    console.log("HISTORICO ENCONTRADO:", data);

    return (data || [])
      .reverse()
      .map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.message
      }));

  } catch (err) {
    console.error("ERRO GERAL HISTORICO:", err);
    return [];
  }
}
