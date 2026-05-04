import { supabase } from "./supabase.js";

export async function saveMessage({
  company,
  from,
  content,
  role,
  intent = null
}) {
  try {
    if (!company) {
      console.error("❌ SAVE MESSAGE: company ausente");
      return false;
    }

    const companyId = company.company_id || company.id;
    const clientKey = company.client_key || String(companyId);

    if (!companyId || !clientKey) {
      console.error("❌ SAVE MESSAGE: company_id ou client_key ausente", {
        companyId,
        clientKey
      });
      return false;
    }

    console.log("💾 SALVANDO MENSAGEM:", {
      company_id: companyId,
      client_key: clientKey,
      from,
      role
    });

    const { data, error } = await supabase
      .from("messages")
      .insert([
        {
          company_id: companyId,
          client_key: clientKey,
          company_name: company.name || company.nome || null,
          user_phone: from,
          direction: role,
          message: content,
          role,
          intent
        }
      ])
      .select();

    if (error) {
      console.error("❌ ERRO AO SALVAR:", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });

      return false;
    }

    console.log("✅ MENSAGEM SALVA:", data?.[0]?.id || true);
    return true;
  } catch (err) {
    console.error("❌ ERRO GERAL SAVE:", err.message);
    return false;
  }
}
