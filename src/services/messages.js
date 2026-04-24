import { supabase } from "./supabase.js";

export async function saveMessage({
  company,
  from,
  content,
  role
}) {
  const { error } = await supabase
    .from("messages")
    .insert([
      {
        company_id: company.id || null,
        client_key: company.client_key || null,
        company_name: company.name || null,
        user_phone: from,
        content,
        role
      }
    ]);

  if (error) {
    console.error("Erro ao salvar mensagem:", error.message);
    return false;
  }

  console.log("Mensagem salva:", {
    user_phone: from,
    role
  });

  return true;
}
