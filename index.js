import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;

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

  console.log("Message received:", text);
  console.log("From user ID:", userId);
  console.log("Chat ID:", chatId);

  if (userId !== ALLOWED_USER_ID) {
    console.log("User not authorized");
    return res.sendStatus(200);
  }

  try {
    const response = await axios.post(
      TELEGRAM_API + "/sendMessage",
      {
        chat_id: chatId,
        text: "Received: " + text
      }
    );

    console.log("Telegram API response:", response.data);
  } catch (error) {
    if (error.response) {
      console.log("Telegram API error:", error.response.data);
    } else {
      console.log("Axios error:", error.message);
    }
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});