import { supabase } from "./supabase.js";

export async function getCompanyByPhoneNumber(identifier) {
  if (!identifier) {
    console.error("❌ identificador não informado");
    return null;
  }

  try {
    // ── Tenta primeiro por phone_number_id (WhatsApp) ─────────
    const { data: byPhone, error: phoneError } = await supabase
      .from("companies")
      .select("*")
      .eq("phone_number_id", identifier)
      .limit(1)
      .maybeSingle();

    if (phoneError && phoneError.code !== "PGRST116") {
      console.error("❌ Erro ao buscar por phone_number_id:", phoneError.message);
    }

    if (byPhone) {
      console.log(`✅ Empresa encontrada por phone_number_id: ${byPhone.name}`);
      return normalize(byPhone);
    }

    // ── Tenta por page_id (Instagram / Facebook) ──────────────
    const { data: byPage, error: pageError } = await supabase
      .from("companies")
      .select("*")
      .eq("page_id", identifier)
      .limit(1)
      .maybeSingle();

    if (pageError && pageError.code !== "PGRST116") {
      console.error("❌ Erro ao buscar por page_id:", pageError.message);
    }

    if (byPage) {
      console.log(`✅ Empresa encontrada por page_id: ${byPage.name}`);
      return normalize(byPage);
    }

    console.warn("⚠️ Nenhuma empresa encontrada para:", identifier);
    return null;

  } catch (err) {
    console.error("❌ Erro inesperado companies:", err.message);
    return null;
  }
}

function normalize(data) {
  return {
    ...data,
    id:             data.id,
    company_id:     data.id,
    client_key:     data.client_key || String(data.id),
    phone_number_id: data.phone_number_id,
    page_id:        data.page_id,
    channel:        data.channel || "whatsapp"
  };
}
