import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${7934650525:AAFH8EGqXZbWGbfILqcVQVFslpZ7YwxKSEY}`;

const ALLOWED_USER_ID = "8104054725";

app.get("/", (req, res) => {
  res.send("Agent running");
});

app.post("/telegram-webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userId = message.from.id.toString();
  const text = message.text || "";

  if (userId !== ALLOWED_USER_ID) {
    return res.sendStatus(200);
  }

  console.log("Message received:", text);

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `Received: ${text}`
  });

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});