const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK - webhook online"));

app.post("/webhook", (req, res) => {
  console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Rodando na porta", PORT));
