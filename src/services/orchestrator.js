// ============================================================
// src/services/knowledge.js
// Lê os arquivos .txt da pasta /knowledge/{clientKey}/
// e retorna o conteúdo como string pro prompt da IA
// ============================================================

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Dois níveis acima de src/services → raiz do projeto
const KNOWLEDGE_ROOT = join(__dirname, "../../knowledge");

/**
 * Carrega o knowledge de um cliente específico.
 * Lê todos os .txt da pasta /knowledge/{clientKey}/ em ordem alfabética.
 *
 * @param {string} clientKey — ex: 'trivia' | 'bandeirante' | 'salao'
 * @returns {string} conteúdo concatenado ou string vazia
 */
export function loadKnowledge(clientKey) {
  try {
    if (!clientKey) return "";

    const folder = join(KNOWLEDGE_ROOT, String(clientKey));

    if (!existsSync(folder)) {
      console.log(`[Knowledge] Pasta não encontrada: ${folder}`);
      return "";
    }

    const files = readdirSync(folder)
      .filter((f) => f.endsWith(".txt"))
      .sort();

    if (!files.length) {
      console.log(`[Knowledge] Nenhum .txt encontrado em: ${folder}`);
      return "";
    }

    const parts = files.map((file) => {
      const fullPath = join(folder, file);
      try {
        const content = readFileSync(fullPath, "utf-8");
        console.log(`[Knowledge] Carregado: ${file} (${content.length} chars)`);
        return content;
      } catch (err) {
        console.log(`[Knowledge] Erro ao ler ${file}:`, err.message);
        return "";
      }
    }).filter(Boolean);

    return parts.join("\n\n");

  } catch (err) {
    console.log("[Knowledge] Erro geral:", err.message);
    return "";
  }
}

export { handleIncomingMessage };
export default handleIncomingMessage;
