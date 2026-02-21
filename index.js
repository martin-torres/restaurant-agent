import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TELEGRAM_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
const ALLOWED_USER_ID = "8104054725";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json"
  }
});

async function downloadTelegramImage(fileId) {
  // Get file path
  const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileRes.data.result.file_path;
  
  // Download file
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const imageRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  
  // Detect MIME type
  const contentType = imageRes.headers['content-type'];
  
  return {
    buffer: Buffer.from(imageRes.data),
    mimeType: contentType || 'image/jpeg'
  };
}

function bufferToBase64(buffer) {
  return buffer.toString('base64');
}

async function analyzeImageWithGemini(base64Image, mimeType) {
  const prompt = `Extract the restaurant menu and branding information from this image.
Return strict JSON matching this schema:
{
  "branding": {
    "colors": {
      "primary": "#HEX (6 hex digits)",
      "secondary": "#HEX (6 hex digits)",
      "accent": "#HEX (6 hex digits)"
    },
    "typography": {
      "classification": "serif|sans-serif|script|display|monospace",
      "weight": "light|regular|bold|extra-bold",
      "style_notes": "string or null"
    }
  },
  "layout": {
    "has_subcategories": true|false,
    "has_featured_items": true|false
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
            "formatted": "string with currency symbol",
            "currency": "USD"
          },
          "is_featured": true|false
        }
      ]
    }
  ]
}

Rules:
- Colors must be 6-digit hex format: #XXXXXX
- Price numeric must be a number
- If uncertain, provide best guess - partial extraction is OK
- Return only JSON, no other text`;

  const imagePart = {
    inlineData: {
      mimeType: mimeType,
      data: base64Image
    }
  };

  const result = await model.generateContent([prompt, imagePart]);
  
  // Parse with trim + try/catch
  try {
    const responseText = result.response.text();
    const json = JSON.parse(responseText.trim());
    return json;
  } catch (error) {
    console.error("Failed to parse Gemini JSON:", error.message);
    throw new Error("Invalid JSON from Gemini");
  }
}

function validateSchema(data) {
  const errors = [];
  
  // Strict: Required top-level
  if (!data.branding) errors.push("Missing branding");
  if (!data.layout) errors.push("Missing layout");
  if (!Array.isArray(data.menu)) errors.push("Menu must be array");
  
  // Strict: Hex colors
  const hexRegex = /^#[0-9A-Fa-f]{6}$/;
  if (data.branding?.colors) {
    Object.values(data.branding.colors).forEach(color => {
      if (color && !hexRegex.test(color)) {
        errors.push(`Invalid hex color: ${color}`);
      }
    });
  }
  
  // Strict: Boolean flags
  if (typeof data.layout?.has_subcategories !== 'boolean') {
    errors.push("layout.has_subcategories must be boolean");
  }
  if (typeof data.layout?.has_featured_items !== 'boolean') {
    errors.push("layout.has_featured_items must be boolean");
  }
  
  // Strict: Numeric prices
  data.menu?.forEach(category => {
    category.items?.forEach(item => {
      if (typeof item.price?.numeric !== 'number') {
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
  let summary = "✅ Menu Analysis Complete\n\n";
  
  // Categories
  summary += "📋 CATEGORIES (" + data.menu.length + ")\n";
  data.menu.forEach(cat => {
    summary += `• ${cat.category}\n`;
  });
  
  // Items
  summary += "\n🍕 ITEMS\n";
  data.menu.forEach(cat => {
    cat.items.forEach(item => {
      const featured = item.is_featured ? " ⭐ featured" : "";
      summary += `• ${item.name} - ${item.price.formatted}${featured}\n`;
    });
  });
  
  // Branding
  summary += "\n🎨 BRANDING\n";
  const c = data.branding.colors;
  summary += `• Primary: ${c.primary}\n`;
  summary += `• Secondary: ${c.secondary}\n`;
  summary += `• Accent: ${c.accent}\n`;
  summary += `• Typography: ${data.branding.typography.classification}, ${data.branding.typography.weight}\n`;
  
  // Layout
  summary += "\n📊 LAYOUT\n";
  summary += `• Subcategories: ${data.layout.has_subcategories ? "Yes" : "No"}\n`;
  summary += `• Featured Items: ${data.layout.has_featured_items ? "Yes" : "No"}\n`;
  
  // Full JSON
  summary += "\n```json\n";
  summary += JSON.stringify(data, null, 2);
  summary += "\n```";
  
  return summary;
}

app.get("/", (req, res) => {
  res.send("Menu Agent running");
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
  
  // Auth check
  if (userId !== ALLOWED_USER_ID) {
    console.log("User not authorized");
    return res.sendStatus(200);
  }
  
  // Handle text
  if (message.text) {
    try {
      await axios.post(TELEGRAM_API + "/sendMessage", {
        chat_id: chatId,
        text: "📸 Please send a restaurant menu image"
      });
    } catch (error) {
      console.error("Telegram API error:", error.message);
    }
    return res.sendStatus(200);
  }
  
  // Handle photo
  if (message.photo) {
    try {
      // Use highest resolution photo (last element)
      const largestPhoto = message.photo[message.photo.length - 1];
      const fileId = largestPhoto.file_id;
      
      console.log("Processing photo:", fileId);
      
      // Download image
      const { buffer, mimeType } = await downloadTelegramImage(fileId);
      console.log("Image downloaded:", mimeType, buffer.length, "bytes");
      
      // Convert to base64 (raw string only, no prefix)
      const base64Image = bufferToBase64(buffer);
      console.log("Converted to base64:", base64Image.length, "chars");
      
      // Analyze with Gemini
      console.log("Sending to Gemini...");
      const data = await analyzeImageWithGemini(base64Image, mimeType);
      console.log("Gemini analysis complete");
      
      // Validate schema
      const validation = validateSchema(data);
      if (!validation.valid) {
        console.error("Validation errors:", validation.errors);
        await axios.post(TELEGRAM_API + "/sendMessage", {
          chat_id: chatId,
          text: "⚠️ Validation errors:\n" + validation.errors.join("\n")
        });
        return res.sendStatus(200);
      }
      console.log("Schema validation passed");
      
      // Format visual summary
      const summary = formatVisualSummary(data);
      console.log("Summary formatted, sending to Telegram...");
      
      // Send response
      await axios.post(TELEGRAM_API + "/sendMessage", {
        chat_id: chatId,
        text: summary,
        parse_mode: "Markdown"
      });
      
      console.log("Response sent successfully");
    } catch (error) {
      console.error("Error processing photo:", error.message);
      console.error("Stack:", error.stack);
      
      try {
        await axios.post(TELEGRAM_API + "/sendMessage", {
          chat_id: chatId,
          text: "❌ Error processing image: " + error.message
        });
      } catch (sendError) {
        console.error("Failed to send error message:", sendError.message);
      }
    }
  }
  
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started on port", process.env.PORT || 3000);
});