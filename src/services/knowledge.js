import fs from "fs";
import path from "path";

export function loadKnowledge(client_key) {
  try {
    if (!client_key) {
      console.warn("⚠️ client_key não informado no knowledge");
      return "";
    }

    const basePath = path.resolve(`./knowledge/${client_key}`);

    if (!fs.existsSync(basePath)) {
      console.warn("⚠️ KNOWLEDGE NÃO ENCONTRADO:", basePath);
      return "";
    }

    const files = fs.readdirSync(basePath);

    if (!files || files.length === 0) {
      console.warn("⚠️ Pasta de knowledge vazia:", basePath);
      return "";
    }

    let knowledgeText = "";

    for (const file of files) {
      if (!file.endsWith(".txt")) continue;

      const filePath = path.join(basePath, file);
      const content = fs.readFileSync(filePath, "utf-8").trim();

      if (!content) continue;

      knowledgeText += `\n\n${content}`;
    }

    console.log("📚 KNOWLEDGE CARREGADO:", {
      client_key,
      arquivos: files.length
    });

    return knowledgeText.trim();

  } catch (err) {
    console.error("❌ ERRO AO CARREGAR KNOWLEDGE:", err.message);
    return "";
  }
}
