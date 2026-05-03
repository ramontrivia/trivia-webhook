import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL não configurado nas variáveis de ambiente.");
}

if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurado nas variáveis de ambiente.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
