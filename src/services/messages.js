import { supabase } from "./supabase.js";

export async function saveMessage({ company, from, content, role }) {
  console.log("TENTANDO SALVAR MENSAGEM:", {
    company_id: company?.id,
    from,
    content,
    role
  });

  const { data, error } = await supabase
    .from("messages")
    .insert([
      {
        company_id: company?.id || null,
        client_key: company?.client_key || null,
        company_name: company?.name || null,
        user_phone: from,
        ditection: role,
        message: content,
        intent: null,
        content: content,
        role: role
      }
    ])
    .select();

  if (error) {
    console.error("ERRO AO SALVAR MENSAGEM:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code
    });

    return false;
  }

  console.log("MENSAGEM SALVA COM SUCESSO:", data);

  return true;
}
