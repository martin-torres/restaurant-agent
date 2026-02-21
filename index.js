import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(express.json());

/* ===============================
   ENVIRONMENT VALIDATION
================================ */

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const ALLOWED_USER_ID = "8104054725";

/* ===============================
   GEMINI INITIALIZATION
================================ */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: "models/gemini-2.5-flash",
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json"
  }
});

/* ===============================
   HELPER FUNCTIONS
================================ */

async function downloadTelegramImage(fileId) {
  const fileResponse = await axios.get(
    `${TELEGRAM_API}/getFile?file_id=${fileId}`
  );

  const filePath = fileResponse.data.result.file_path;

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const imageResponse = await axios.get(fileUrl, {
    responseType: "arraybuffer"
  });

  return {
    buffer: Buffer.from(imageResponse.data),
    mimeType: "image/jpeg"
  };
}

function bufferToBase64(buffer) {
  return buffer.toString("base64");
}

async function analyzeImageWithGemini(base64Image, mimeType) {
  const prompt = `
Analyze this restaurant menu image and return STRICT JSON only.

Required structure:

{
  "branding": {
    "colors": {
      "primary": "#HEX",
      "secondary": "#HEX",
      "accent": "#HEX"
    },
    "typography": {
      "classification": "serif|sans-serif|script|display|monospace",
      "weight": "light|regular|bold|extra-bold",
      "style_notes": "string or null"
    }
  },
  "layout": {
    "has_subcategories": boolean,
    "has_featured_items": boolean
  },
  "menu": [
    {
      "category": "string",
      "subcategory": "string or null",
      "items": [
        {
          "name": "string",
          "description": "string or null",
          "price": {
            "numeric": number,
            "formatted": "string",
            "currency": "MXN"
          },
          "is_featured": boolean
        }
      ]
    }
  ]
}

Rules:
- Use #RRGGBB format for colors.
- Prices numeric must be number type.
- Allow partial extraction if unclear.
- Return JSON only.
`;

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        mimeType: mimeType,
        data: base64Image
      }
    }
  ]);

  try {
    const responseText = result.response.text();
    return JSON.parse(responseText.trim());
  } catch (err) {
    throw new Error("Invalid JSON from Gemini");
  }
}

function validateSchema(data) {
  const errors = [];
  const hexRegex = /^#[0-9A-Fa-f]{6}$/;

  if (!data.branding) errors.push("Missing branding");
  if (!data.layout) errors.push("Missing layout");
  if (!Array.isArray(data.menu)) errors.push("Menu must be array");

  if (data.branding?.colors) {
    Object.values(data.branding.colors).forEach(color => {
      if (color && !hexRegex.test(color)) {
        errors.push(`Invalid hex color: ${color}`);
      }
    });
  }

  if (typeof data.layout?.has_subcategories !== "boolean")
    errors.push("layout.has_subcategories must be boolean");

  if (typeof data.layout?.has_featured_items !== "boolean")
    errors.push("layout.has_featured_items must be boolean");

  data.menu?.forEach(category => {
    category.items?.forEach(item => {
      if (typeof item.price?.numeric !== "number") {
        errors.push(`Price numeric must be number for: ${item.name}`);
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

function formatVisualSummary(data) {
  let totalItems = 0;
  data.menu.forEach(cat => {
    totalItems += cat.items?.length || 0;
  });

  return `
✅ Analysis Complete

📂 Categories: ${data.menu.length}
🍽 Total Items: ${totalItems}

🎨 Primary: ${data.branding.colors.primary}
🅰 Typography: ${data.branding.typography.classification}

📌 Subcategories: ${data.layout.has_subcategories}
⭐ Featured Items: ${data.layout.has_featured_items}
`;
}

/* ===============================
   ROUTES
================================ */

app.get("/", (req, res) => {
  res.send("Agent running");
});

app.post("/telegram-webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const userId = message.from.id.toString();
  const chatId = message.chat.id;

  if (userId !== ALLOWED_USER_ID) {
    return res.sendStatus(200);
  }

  try {
    if (!message.photo) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "📸 Please send a restaurant menu image"
      });
      return res.sendStatus(200);
    }

    const largestPhoto = message.photo[message.photo.length - 1];

    const { buffer, mimeType } = await downloadTelegramImage(
      largestPhoto.file_id
    );

    const base64 = bufferToBase64(buffer);

    let data;

    try {
      data = await analyzeImageWithGemini(base64, mimeType);
    } catch {
      data = await analyzeImageWithGemini(base64, mimeType); // retry once
    }

    const validation = validateSchema(data);

    let summary = formatVisualSummary(data);

    if (!validation.valid) {
      summary += "\n⚠ Partial extraction with validation warnings.";
    }

    const jsonString = JSON.stringify(data, null, 2);

    const finalMessage = `${summary}\n\`\`\`json\n${jsonString}\n\`\`\``;

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: finalMessage,
      parse_mode: "Markdown"
    });

    res.sendStatus(200);
  } catch (error) {
    console.error(error);

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `❌ Error processing image: ${error.message}`
    });

    res.sendStatus(200);
  }
});

/* ===============================
   SERVER
================================ */

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});