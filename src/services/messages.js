import { supabase } from "./supabase.js";

export async function saveMessage({
  company,
  from,
  content,
  role
}) {
  try {
    console.log("SALVANDO MENSAGEM:", {
      company: company?.id,
      from,
      content,
      role
    });

    const { data, error } = await supabase
      .from("messages")
      .insert([
        {
          company: company?.id || null, // ✅ CORRETO
          client_key: company?.client_key || null,
          company_name: company?.name || null,
          user_phone: from,
          ditection: role, // ✅ usa o nome EXATO da sua coluna
          message: content,
          role: role,
          intent: null
        }
      ])
      .select();

    if (error) {
      console.error("ERRO AO SALVAR:", error);
      return false;
    }

    console.log("SALVO COM SUCESSO:", data);
    return true;

  } catch (err) {
    console.error("ERRO GERAL SAVE:", err);
    return false;
  }
}
