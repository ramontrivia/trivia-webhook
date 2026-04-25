import { supabase } from "./supabase.js";

export async function saveMessage({
  company,
  from,
  content,
  role
}) {
  try {
    console.log("SALVANDO MENSAGEM:", {
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
          direction: role,
          message: content,
          role: role,
          intent: null
        }
      ])
      .select();

    if (error) {
      console.error("ERRO AO SALVAR:", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });

      return false;
    }

    console.log("SALVO COM SUCESSO:", data);
    return true;

  } catch (err) {
    console.error("ERRO GERAL SAVE:", err);
    return false;
  }
}
