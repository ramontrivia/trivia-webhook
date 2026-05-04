import { supabase } from "./supabase.js";

export async function getCompanyByPhoneNumber(phoneNumberId) {
  if (!phoneNumberId) {
    console.error("❌ phoneNumberId não informado");
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .eq("phone_number_id", phoneNumberId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("❌ Erro ao buscar empresa:", error.message);
      return null;
    }

    if (!data) {
      console.warn("⚠️ Nenhuma empresa encontrada para:", phoneNumberId);
      return null;
    }

    return {
      ...data,
      id: data.id,
      company_id: data.id,
      client_key: data.client_key || String(data.id),
      phone_number_id: data.phone_number_id
    };
  } catch (err) {
    console.error("❌ Erro inesperado companies:", err.message);
    return null;
  }
}
