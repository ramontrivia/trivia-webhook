import express from "express";
import webhookRoutes from "./routes/webhook.js";

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.use("/", webhookRoutes);

app.listen(PORT, () => {
  console.log("SERVER RUNNING ON PORT:", PORT);
});
