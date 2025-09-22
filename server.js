import express from "express";
import dotenv from "dotenv";
import fs from "fs/promises";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";
import winston from "winston";
import { readFileSync } from "fs";
import OpenAI from "openai";

dotenv.config();

const app = express();

// Trust proxy ПЕРВЫМ! (фикс для Render X-Forwarded-For)
app.set('trust proxy', 1);  // ← Изменено на 1 (Render single proxy)

// Logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'error.log' })]
});

// Helmet с ЯВНЫМ CSP (разрешаем unsafe-inline для твоего inline CSS/JS)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "*"],  // ← Разрешаем всё для теста
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],  // ← Для Vanilla JS
      styleSrc: ["'self'", "'unsafe-inline'"],  // ← Для градиентов и inline CSS
      connectSrc: ["'self'", "https://api.openai.com", "https://*.tilda.ws"],  // ← OpenAI + Tilda
      imgSrc: ["'self'", "data:", "https:"],  // ← Фото товаров
      fontSrc: ["'self'", "data:", "https:"],
      frameAncestors: ["'self'", "https://*.tilda.ws"]  // ← Для embed в Tilda
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

app.use(express.json({ limit: '10kb' }));

// Rate limit ТОЛЬКО на API (с keyGenerator по IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.ip  // ← Явно использует X-Forwarded-For
});
app.use('/api/', limiter);  // ← Только на /api/ (не на static)

// CORS с explicit origins
app.use(cors({
  origin: ['*', 'https://entech-chat.onrender.com', 'https://*.tilda.ws', 'http://localhost:3000'],
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  credentials: true
}));

// Custom middleware для логирования headers (дебаг)
app.use((req, res, next) => {
  logger.info(`Request headers: ${JSON.stringify(req.headers)}`);
  next();
});

// Static files (если есть public folder)
app.use(express.static('public'));

// Load catalog & scenario
let catalog = [];
let scenario = {};
try {
  catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
  scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
  logger.info(`Loaded: ${catalog.length} items, scenario OK`);
} catch (err) {
  logger.error(`Load error: ${err.message}`);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Улучшенный поиск (с ключевыми словами) — без изменений
function findProducts(query) {
  const cacheKey = `search:${query}`;
  let products = cache.get(cacheKey);
  if (products) return products;

  const q = query.toLowerCase();
  
  // Ключевые слова для поиска
  const keywords = {
    power: q.match(/(\d{2,3})\s*(Вт|W)/)?.[1] || null,
    ip: q.match(/ip(\d{2})/)?.[1] || null,
    category: q.includes('склад') || q.includes('цех') || q.includes('производство') ? 'промышленные' :
              q.includes('улица') || q.includes('двор') ? 'уличные' :
              q.includes('офис') ? 'офисные' : null
  };

  products = catalog
    .map(item => {
      let score = 0;
      
      // Поиск по модели и названию
      if (item.model?.toLowerCase().includes(q)) score += 5;
      if (item.name?.toLowerCase().includes(q)) score += 3;
      
      // Поиск по категории
      if (keywords.category && item.category?.toLowerCase().includes(keywords.category)) score += 4;
      
      // Поиск по мощности
      if (keywords.power && item.power_w) {
        const powerDiff = Math.abs(item.power_w - parseInt(keywords.power));
        if (powerDiff <= 50) score += 3;
        else if (powerDiff <= 100) score += 2;
      }
      
      // Поиск по IP
      if (keywords.ip && item.ip_rating?.toLowerCase() === `ip${keywords.ip}`) score += 4;
      
      // Общий поиск по тексту
      if (item.raw?.toLowerCase().includes(q)) score += 2;
      
      return { ...item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  cache.set(cacheKey, products);
  return products;
}

// Save quote — без изменений
app.post("/api/quote", async (req, res) => {
  try {
    const { name, contact, products } = req.body;
    if (!contact) {
      return res.status(400).json({ error: "Contact required" });
    }

    const entry = { timestamp: new Date().toISOString(), name, contact, products };
    
    let quotes = JSON.parse(await fs.readFile("quotes.json", "utf8").catch(() => "[]"));
    quotes.push(entry);
    await fs.writeFile("quotes.json", JSON.stringify(quotes, null, 2));

    logger.info(`Lead saved: ${contact}`);
    res.json({ ok: true, message: "Менеджер свяжется в течение часа!" });
  } catch (err) {
    logger.error(`Quote error: ${err.message}`);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: "Invalid message" });
    }

    logger.info(`Chat: ${message.slice(0, 50)}`);
    
    // Улучшенный поиск
    const products = findProducts(message);
    const productText = products.length ? 
      `\n\n**Рекомендации из каталога Entech:**\n${products.map((p, i) => 
        `${i+1}. **${p.model}** (${p.power_w}Вт, ${p.lumens ? p.lumens + 'лм' : 'не указан'}, ${p.ip_rating || 'IP не указан'}) — ${p.category}\n`
      ).join('')}` : '';

    // Улучшенный системный промпт — без изменений
    const sysPrompt = `
Ты — AI-консультант Entech по светотехнике. Твоя цель: помочь клиенту подобрать освещение и получить заявку на коммерческое предложение.

**ПРАВИЛА:**
1. **ВСЕГДА рекомендовай 2-3 товара** из каталога при упоминании типа помещения, IP, мощности или площади.
2. **Если клиент упоминает**: склад/цех → промышленные IP65 150-300Вт; офис → офисные IP20 30-60Вт; улица → уличные IP65+ 50-150Вт.
3. **НЕ спрашивай много вопросов** — максимум 1 уточнение, потом рекомендации.
4. **Цены НЕ называй** — "менеджер рассчитает индивидуально".
5. **Всегда заканчивай CTA**: "Хотите персональное КП с расчётом? Укажите телефон/email."

**ФОРМАТ ОТВЕТА:**
- **Введение**: "Для [тип помещения] рекомендую..."
- **Рекомендации**: 2-3 модели с краткими характеристиками (модель, Вт, лм, IP, гарантия).
- **Преимущества**: "Гарантия 5-7 лет, бесплатное обслуживание, производство под заказ."
- **CTA**: "Хотите КП в PDF? Укажите контакт для менеджера."

**ТЕКУЩИЙ ЗАПРОС**: ${message}
${productText ? 'КАТАЛОГ НАШЁЛ:' + productText : 'Каталог не нашёл подходящих — уточни параметры.'}

Отвечай **конкретно и убедительно**, предлагай товары, закрывай на заявку.
`;

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: message }
      ],
      temperature: 0.3,
      max_tokens: 400
    });

    res.json({ 
      assistant: completion.choices[0].message.content, 
      products 
    });
  } catch (err) {
    logger.error(`Chat error: ${err.message}`);
    res.status(500).json({ error: "AI error" });
  }
});

// Root route для index.html (если нужно)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Server on :${PORT}`));