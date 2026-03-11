// server.js (ESM) - TRÍVIA Webhook (WhatsApp Cloud API) + OpenAI + Multi-Client
// Modo seguro: Supabase + fallback para variáveis legadas

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/** =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v21.0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const COMMERCIAL_PHONE = normalizePhone(process.env.COMMERCIAL_PHONE || "");

// legado / fallback
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const PHONE_NUMBER_ID_BUSCAI = process.env.PHONE_NUMBER_ID_BUSCAI;
const WHATSAPP_TOKEN_BUSCAI = process.env.WHATSAPP_TOKEN_BUSCAI;

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

/** =========================
 * Util
 * ========================= */
function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^\d]/g, "");
}

function safeTrim(v) {
  return String(v || "").trim();
}

function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function makeCompanyKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** =========================
 * Companies / Cache
 * ========================= */
let COMPANIES_CACHE = [];

function getLegacyCompanies() {
  const companies = [];

  if (PHONE_NUMBER_ID && WHATSAPP_TOKEN) {
    companies.push({
      id: "legacy_trivia",
      name: "TRIVIA TECNOLOGIA",
      key: "trivia_tecnologia",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID),
      token: safeTrim(WHATSAPP_TOKEN),
      segment: "tecnologia",
      source: "legacy",
    });
  }

  if (PHONE_NUMBER_ID_BUSCAI && WHATSAPP_TOKEN_BUSCAI) {
    companies.push({
      id: "legacy_buscai",
      name: "BUSCA AI",
      key: "busca_ai",
      phoneNumberId: safeTrim(PHONE_NUMBER_ID_BUSCAI),
      token: safeTrim(WHATSAPP_TOKEN_BUSCAI),
      segment: "mobilidade",
      source: "legacy",
    });
  }

  return companies;
}

async function loadCompaniesFromSupabase() {
  if (!supabase) {
    console.log("⚠️ Supabase não configurado. Usando fallback legado.");
    return [];
  }

  try {
    const { data, error } = await supabase.from("companies").select("*");

    if (error) {
      console.error("❌ Erro ao carregar companies do Supabase:", error.message);
      return [];
    }

    console.log(`📦 Linhas brutas do Supabase: ${(data || []).length}`);

    const mapped = (data || []).map((row) => ({
      id: row.id,
      name: safeTrim(row.name),
      key: makeCompanyKey(safeTrim(row.name) || `company_${row.id}`),
      phoneNumberId: safeTrim(row.phone_number_id),
      token: safeTrim(row.whatsapp_token),
      segment: safeTrim(row.segment),
      source: "supabase",
    }));

    console.log(
      "📦 Empresas mapeadas:",
      JSON.stringify(
        mapped.map((c) => ({
          id: c.id,
          name: c.name,
          key: c.key,
          phoneNumberId: c.phoneNumberId,
          tokenPresent: !!c.token,
          segment: c.segment,
          source: c.source,
        }))
      )
    );

    const validCompanies = mapped.filter((c) => c.phoneNumberId && c.token);

    console.log(`✅ Empresas válidas do Supabase: ${validCompanies.length}`);

    return validCompanies;
  } catch (err) {
    console.error("❌ Falha inesperada ao carregar companies:", err.message);
    return [];
  }
}

async function refreshCompaniesCache() {
  const dbCompanies = await loadCompaniesFromSupabase();

  if (dbCompanies.length > 0) {
    COMPANIES_CACHE = dbCompanies;
    console.log(
      `✅ Cache carregado pelo
