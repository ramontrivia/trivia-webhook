import fs from "fs";
import path from "path";

export function loadKnowledge(client_key) {
  try {
    const basePath = path.resolve(`./knowledge/${client_key}`);

    if (!fs.existsSync(basePath)) {
      console.log("KNOWLEDGE NAO ENCONTRADO:", basePath);
      return "";
    }

    const files = fs.readdirSync(basePath);

    let knowledgeText = "";

    for (const file of files) {
      if (file.endsWith(".txt")) {
        const filePath = path.join(basePath, file);
        const content = fs.readFileSync(filePath, "utf-8");

        knowledgeText += `\n\n### ${file}\n${content}`;
      }
    }

    console.log("KNOWLEDGE CARREGADO:", files);

    return knowledgeText;

  } catch (err) {
    console.error("ERRO AO CARREGAR KNOWLEDGE:", err);
    return "";
  }
}
