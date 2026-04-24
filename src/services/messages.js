import { supabase } from "./supabase.js";

export async function saveMessage({
  companyId,
  companyName,
  clientKey,
  userPhone,
  content,
  role
}) {
  const { error } = await supabase
    .from("messages")
    .insert([
      {
        company_id: companyId,
        company_name: companyName,
        client_key: clientKey,
        user_phone: userPhone,
        content,
        role
      }
    ]);

  if (error) {
    console.error("Erro ao salvar mensagem:", error.message);
  }
}
