import { supabase } from "./supabase.js";

export async function saveMessage({
  companyId,
  from,
  content,
  role
}) {
  const { error } = await supabase
    .from("messages")
    .insert([
      {
        company_id: companyId,
        from_number: from,
        content,
        role
      }
    ]);

  if (error) {
    console.error("Erro ao salvar mensagem:", error.message);
  }
}
