import express from "express";

const router = express.Router();

router.get("/admin", async (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Painel TRIVIA</title>
      </head>
      <body>
        <h1>Painel TRIVIA</h1>
        <p>Painel carregado com sucesso.</p>
      </body>
    </html>
  `);
});

export default router;
