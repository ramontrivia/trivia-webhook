import { supabase } from "./supabase.js";

export async function getConversationHistory({ company, from, limit = 10 }) {
  try {
    if (!company || !from) {
      console.warn("⚠️ HISTÓRICO: company ou from ausente");
      return [];
    }

    const companyId = company.company_id || company.id;
    const clientKey = company.client_key || String(companyId);

    console.log("📜 BUSCANDO HISTÓRICO:", {
      company_id: companyId,
      client_key: clientKey,
      from
    });

    const { data, error } = await supabase
      .from("messages")
      .select("message, role, created_at")
      .eq("company_id", companyId)
      .eq("client_key", clientKey)
      .eq("user_phone", from)
      .not("message", "is", null)
      .not("role", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("❌ ERRO AO BUSCAR HISTÓRICO:", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });

      return [];
    }

    return (data || [])
      .reverse()
      .map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.message
      }));
  } catch (err) {
    console.error("❌ ERRO GERAL HISTÓRICO:", err.message);
    return [];
  }
}
