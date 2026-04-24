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
        company: company.id || null,
        client_key: company.client_key || null,
        company_name: company.name || null,
        user_phone: from,
        ditection: role,
        message: content,
        content: content,
        role: role
      }
    ]);

  if (error) {
    console.error("Erro ao salvar mensagem:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code
    });
    return false;
  }

  console.log("Mensagem salva com sucesso:", {
    user_phone: from,
    role
  });

  return true;
}
