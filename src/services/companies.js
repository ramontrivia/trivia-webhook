import { supabase } from "./supabase.js";

export async function getCompanyByPhoneNumber(phoneNumberId) {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("phone_number_id", phoneNumberId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar empresa:", error.message);
    return null;
  }

  return data;
}
