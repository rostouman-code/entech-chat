// server.js
import express from "express";
import dotenv from "dotenv";
import fs from "fs/promises";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";
import winston from "winston";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";
import OpenAI from "openai";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Trust proxy
app.set("trust proxy", 1);

// Logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log" })
  ]
});

// Helmet
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    referrerPolicy: { policy: "same-origin" }
  })
);

app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  message: { error: "Слишком много запросов. Попробуйте через 15 минут." }
});
app.use("/api/", limiter);

// CORS
app.use(
  cors({
    origin: [
      "https://entech-chat.onrender.com",
      "https://*.tilda.ws",
      "https://tilda.cc",
      "http://localhost:3000",
      "http://localhost:10000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

// Static files
app.use(express.static(__dirname));

// Middleware logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} from ${req.ip} - UA: ${req.get("User-Agent")}`);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Load catalog & scenario
let catalog = [];
let scenario = {};
const cache = new NodeCache({ stdTTL: 600 });

try {
  catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
  scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
  logger.info(`Loaded: ${catalog.length} items, scenario OK`);
} catch (err) {
  logger.error(`Load error: ${err.message}`);
  catalog = [];
  scenario = {};
}

// OpenAI init
let openai;
try {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  logger.info("OpenAI client initialized");
} catch (err) {
  logger.error(`OpenAI init error: ${err.message}`);
  openai = null;
}

// utils
function calculateLumens(power_w, lumens) {
  if (!power_w || isNaN(power_w)) return null;
  const calculated = Math.round(power_w * 130);
  return lumens && lumens > power_w * 100 ? lumens : calculated;
}
function calculateQuantity(area, targetLux, lumens, utilization = 0.6) {
  if (!area || !targetLux || !lumens) return null;
  const totalLumensNeeded = (area * targetLux) / utilization;
  const quantity = Math.ceil(totalLumensNeeded / lumens);
  return Math.max(1, quantity);
}

function findProducts(query, category = null) {
  if (!query) return [];
  const cacheKey = `search:${query.toLowerCase()}:${category || "all"}`;
  let products = cache.get(cacheKey);
  if (products !== undefined) return products;

  const q = query.toLowerCase();
  const keywords = {
    power: q.match(/(\d{1,3})\s*(Вт|W|ватт)/)?.[1] || null,
    ip: q.match(/ip(\d{2})/)?.[1] || null,
    category:
      category ||
      (q.includes("склад") || q.includes("цех") || q.includes("производство") || q.includes("завод")
        ? "промышленные"
        : q.includes("улица") || q.includes("двор") || q.includes("парковка") || q.includes("внешнее")
        ? "уличные"
        : q.includes("офис") || q.includes("кабинет") || q.includes("контора")
        ? "офисные"
        : q.includes("магазин") || q.includes("торговый") || q.includes("retail")
        ? "торговые"
        : null),
    area: q.match(/(\d{1,3})\s*(м²|кв\.м|площадь)/)?.[1] || null
  };

  products = catalog
    .filter((item) => item.power_w && !isNaN(item.power_w))
    .map((item) => {
      let score = 0;
      const itemLower = {
        model: (item.model || "").toLowerCase(),
        name: (item.name || "").toLowerCase(),
        category: (item.category || "").toLowerCase(),
        raw: (item.raw || item.description || "").toLowerCase()
      };
      if (itemLower.model.includes(q)) score += 5;
      if (itemLower.name.includes(q)) score += 3;
      if (keywords.category && itemLower.category.includes(keywords.category)) score += 4;
      if (keywords.power && item.power_w) {
        const targetPower = parseInt(keywords.power);
        const powerDiff = Math.abs(item.power_w - targetPower);
        if (powerDiff <= 10) score += 3;
        else if (powerDiff <= 30) score += 2;
      }
      if (keywords.ip && item.ip_rating?.toLowerCase() === `ip${keywords.ip}`) score += 4;
      if (itemLower.raw.includes(q)) score += 2;
      if (q.includes("офис")) score += 1;
      if (q.includes("улица")) score += 1;
      if (q.includes("склад") || q.includes("цех")) score += 1;

      const calculatedLumens = calculateLumens(item.power_w, item.lumens);
      const displayLumens = calculatedLumens ? `${calculatedLumens}лм` : "не указан";

      return {
        ...item,
        score,
        relevance: score > 0 ? "high" : "low",
        display_lumens: displayLumens
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  cache.set(cacheKey, products);
  return products;
}

// API: quote
app.post("/api/quote", async (req, res) => {
  try {
    const { name, contact, products, message, context } = req.body;
    if (!contact) return res.status(400).json({ error: "Контакт обязателен для заявки" });
    const entry = {
      timestamp: new Date().toISOString(),
      name: name || "Не указан",
      contact,
      products: products || [],
      message: message || "",
      context: context || {},
      source: req.get("User-Agent") || "Unknown"
    };
    try {
      let quotes = JSON.parse(await fs.readFile("quotes.json", "utf8").catch(() => "[]"));
      quotes.push(entry);
      await fs.writeFile("quotes.json", JSON.stringify(quotes, null, 2));
      logger.info(`Lead saved: ${contact}`);
    } catch (fileErr) {
      logger.error(`File write error: ${fileErr.message}`);
    }
    res.json({
      ok: true,
      message: "✅ Заявка принята! Менеджер свяжется с вами в течение часа.",
      leadId: Date.now().toString()
    });
  } catch (err) {
    logger.error(`Quote API error: ${err.message}`);
    res.status(500).json({ error: "Ошибка сохранения заявки" });
  }
});

// API: transfer-to-manager
app.post("/api/transfer-to-manager", async (req, res) => {
  try {
    const { contact, chatHistory } = req.body;
    if (!contact || !chatHistory) return res.status(400).json({ error: "Необходимы контакт и история чата" });
    const entry = {
      timestamp: new Date().toISOString(),
      contact,
      chatHistory,
      source: req.get("User-Agent") || "Unknown"
    };
    try {
      let transfers = JSON.parse(await fs.readFile("transfers.json", "utf8").catch(() => "[]"));
      transfers.push(entry);
      await fs.writeFile("transfers.json", JSON.stringify(transfers, null, 2));
      logger.info(`Transfer saved: ${contact}`);
    } catch (fileErr) {
      logger.error(`Transfer write error: ${fileErr.message}`);
    }
    res.json({ ok: true, message: "✅ Запрос передан менеджеру. Ожидайте звонка." });
  } catch (err) {
    logger.error(`Transfer API error: ${err.message}`);
    res.status(500).json({ error: "Ошибка передачи запроса" });
  }
});

// API: chat
app.post("/api/chat", async (req, res) => {
  let sessionCacheKey = `session:${req.ip}`;
  let historyCacheKey = `history:${req.ip}`;
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "Сообщение не указано" });

    let session = cache.get(sessionCacheKey) || { step: "greeting", context: {}, phrase_index: 0 };
    let history =
      cache.get(historyCacheKey) || [
        { role: "system", content: scenario.welcome?.message || "Здравствуйте! Я — ваш AI-консультант Entech." }
      ];

    history.push({ role: "user", content: message });

    // quick classifier
    const messageLower = (message || "").toLowerCase();
    if (messageLower.includes("офис")) {
      session.context.type = "office";
      session.step = "office_questions";
    } else if (messageLower.includes("цех")) {
      session.context.type = "workshop";
      session.step = "workshop_questions";
    } else if (messageLower.includes("улица")) {
      session.context.type = "street";
      session.step = "street_questions";
    } else if (messageLower.includes("склад")) {
      session.context.type = "warehouse";
      session.step = "warehouse_questions";
    } else if (messageLower.includes("ваш вариант") || messageLower.includes("другое")) {
      session.context.type = "custom";
      session.step = "custom_questions";
    } else if (messageLower.includes("менеджер") || messageLower.includes("позвать")) {
      session.step = "transfer_to_manager";
    }

    // parse params
    const areaMatch = message.match(/(\d{1,6})\s*(м²|кв|площадь)/i);
    const heightMatch = message.match(/высота\s+(\d{1,2})\s*м/i);
    const luxMatch = message.match(/(\d{2,4})\s*лк/i);
    if (areaMatch) session.context.area = areaMatch[1];
    if (heightMatch) session.context.height = heightMatch[1];
    if (luxMatch) session.context.lux = luxMatch[1];

    const products = findProducts(message, session.context.type);

    // If OpenAI not available - fallback
    if (!openai) {
      const fallback = scenario.fallback?.openai_down || "AI временно недоступен. Напишите параметры, и я помогу.";
      history.push({ role: "assistant", content: fallback });
      cache.set(sessionCacheKey, session, 600);
      cache.set(historyCacheKey, history, 600);
      return res.json({
        assistant: fallback,
        products,
        session: { step: session.step, context: session.context }
      });
    }

    // System prompt
    const sysPrompt = `Ты — профессиональный AI-консультант Энтех по светотехнике. ЦЕЛЬ: собрать параметры → дать 1 персонализированное решение → получить лид.
КОНТЕКСТ: ${JSON.stringify(session.context)}
ШАГ: ${session.step}`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "system", content: sysPrompt }, ...history],
      temperature: 0.3,
      max_tokens: 400
    });

    let assistantResponse = completion?.choices?.[0]?.message?.content || "";

    // Fallbacks
    if (!products.length) {
      assistantResponse = scenario.fallback?.no_products || "Не нашёл подходящий вариант. Уточните параметры — и я предложу аналоги.";
    }
    if (!assistantResponse || assistantResponse.trim().length < 5) {
      assistantResponse = scenario.fallback?.unclear_request || "Можете уточнить параметры объекта?";
    }

    history.push({ role: "assistant", content: assistantResponse });
    cache.set(sessionCacheKey, session, 600);
    cache.set(historyCacheKey, history, 600);

    logger.info(`AI response to ${req.ip}: ${assistantResponse.slice(0, 200)}`);
    res.json({
      assistant: assistantResponse.trim(),
      products,
      session: { step: session.step, context: session.context },
      tokens: completion.usage || null
    });
  } catch (err) {
    logger.error(`Chat API error: ${err.message}`);
    return res.status(500).json({ error: "Ошибка на сервере. Попробуйте позже." });
  }
});

// root
app.get("/", (req, res) => {
  const widgetPath = path.join(__dirname, "widget.html");
  try {
    fs.accessSync(widgetPath);
    res.sendFile(widgetPath);
  } catch {
    res.status(404).send("widget.html not found");
  }
});

// health
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    catalogSize: catalog.length,
    openai: !!openai,
    uptime: process.uptime(),
    cacheSize: cache.keys().length
  });
});

// 404 handlers
app.use("/api/*", (req, res) => res.status(404).json({ error: "API endpoint not found" }));
app.use((req, res) => res.status(404).json({ error: "Page not found" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server started on port ${PORT}`);
});
