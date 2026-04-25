import express from "express";
import { supabase } from "../services/supabase.js";

const router = express.Router();

router.get("/admin", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.send("Erro ao buscar mensagens: " + error.message);
    }

    const rows = data
      .map((msg) => {
        return `
          <tr>
            <td>${msg.created_at || ""}</td>
            <td>${msg.user_phone || ""}</td>
            <td>${msg.role || ""}</td>
            <td>${msg.content || ""}</td>
          </tr>
        `;
      })
      .join("");

    res.send(`
      <html>
        <head>
          <title>Painel TRIVIA</title>
          <style>
            body { font-family: Arial; padding: 20px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ccc; padding: 8px; }
            th { background: #eee; }
          </style>
        </head>
        <body>
          <h1>Painel TRIVIA</h1>

          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Telefone</th>
                <th>Role</th>
                <th>Mensagem</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </body>
      </html>
    `);
  } catch (err) {
    res.send("Erro geral: " + err.message);
  }
});

export default router;
