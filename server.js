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

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log' })
  ]
});

app.set('trust proxy', 1);

// Helmet (keep defaults but we handle frame-ancestors below)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiter for /api
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' }
});
app.use('/api/', limiter);

// CORS: allow Tilda, localhost and our domain; tolerate missing origin (non-browser)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-side or same-origin requests
    const ok =
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.endsWith('.tilda.ws') ||
      origin === 'https://tilda.cc' ||
      origin === 'https://entech-chat.onrender.com' ||
      origin.includes('your-testing-domain.example'); // add if needed
    return cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS']
}));

// Serve static files
app.use(express.static(__dirname));

// Middleware: logging + permissive frame-ancestors for Tilda embed
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} from ${req.ip} - UA: ${req.get('User-Agent')}`);

  // remove legacy X-Frame-Options if present
  res.removeHeader('X-Frame-Options');

  // Allow embedding on Tilda and our own domain (adjust as necessary)
  res.setHeader('Content-Security-Policy',
    "default-src 'self' data: blob: https: http:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:; " +
    "style-src 'self' 'unsafe-inline' https: http:; " +
    "img-src 'self' data: blob: https: http:; " +
    "connect-src 'self' https: http: ws: wss:; " +
    "frame-ancestors 'self' https://tilda.cc https://*.tilda.ws https://entech-chat.onrender.com;"
  );

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});

// Load catalog & scenario
let catalog = [];
let scenario = {};
const cache = new NodeCache({ stdTTL: 600 });

try {
  catalog = JSON.parse(readFileSync(path.join(__dirname, 'catalog.json'), 'utf8') || '[]');
  scenario = JSON.parse(readFileSync(path.join(__dirname, 'scenario.json'), 'utf8') || '{}');
  logger.info(`Loaded: ${catalog.length} items, scenario OK`);
} catch (err) {
  logger.error(`Load error: ${err.message}`);
  catalog = [];
  scenario = {};
}

// OpenAI init (optional)
let openai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    logger.info("OpenAI client initialized");
  } else {
    logger.warn("OPENAI_API_KEY not set — using fallback responses");
  }
} catch (e) {
  logger.error("OpenAI init failed: " + e.message);
  openai = null;
}

// Utilities
function calculateLumens(power_w, lumens) {
  if (!power_w || isNaN(power_w)) return null;
  const calculated = Math.round(power_w * 130);
  return (lumens && lumens > power_w * 100) ? lumens : calculated;
}
function calculateQuantity(area, targetLux, lumens, utilization = 0.6) {
  if (!area || !targetLux || !lumens) return null;
  const totalLumensNeeded = area * targetLux / utilization;
  const quantity = Math.ceil(totalLumensNeeded / lumens);
  return Math.max(1, quantity);
}

function findProducts(query, category = null) {
  if (!query) return [];
  const cacheKey = `search:${query.toLowerCase()}:${category || 'all'}`;
  let products = cache.get(cacheKey);
  if (products !== undefined) return products;

  const q = String(query).toLowerCase();
  const keywords = {
    power: q.match(/(\d{1,3})\s*(Вт|W|ватт)/)?.[1] || null,
    ip: q.match(/ip(\d{2})/)?.[1] || null,
    category: category || (
      q.includes('склад') || q.includes('цех') || q.includes('производство') || q.includes('завод') ? 'промышленные' :
      q.includes('улица') || q.includes('двор') || q.includes('парковка') || q.includes('внешнее') ? 'уличные' :
      q.includes('офис') || q.includes('кабинет') || q.includes('контора') ? 'офисные' :
      q.includes('магазин') || q.includes('торговый') || q.includes('retail') ? 'торговые' : null
    ),
    area: q.match(/(\d{1,6})\s*(м²|кв\.м|площадь)/)?.[1] || null
  };

  products = catalog
    .filter(item => item.model)
    .map(item => {
      let score = 0;
      const itemLower = {
        model: (item.model || '').toLowerCase(),
        name: (item.name || '').toLowerCase(),
        category: (item.category || '').toLowerCase(),
        raw: (item.raw || item.description || '').toLowerCase()
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
      if (keywords.ip && (item.ip_rating || '').toLowerCase() === `ip${keywords.ip}`) score += 4;
      if (itemLower.raw.includes(q)) score += 2;
      if (q.includes('офис')) score += 1;
      if (q.includes('улица')) score += 1;
      if (q.includes('склад') || q.includes('цех')) score += 1;

      const calculatedLumens = calculateLumens(item.power_w, item.lumens);
      const displayLumens = calculatedLumens ? `${calculatedLumens}лм` : (item.lumens ? `${item.lumens}лм` : 'не указан');

      return {
        ...item,
        score,
        relevance: score > 0 ? 'high' : 'low',
        display_lumens: displayLumens
      };
    })
    .filter(item => item.score > 0)
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
      name: name || 'Не указан',
      contact,
      products: products || [],
      message: message || '',
      context: context || {},
      source: req.get('User-Agent') || 'Unknown'
    };

    try {
      const raw = await fs.readFile(path.join(__dirname, 'quotes.json'), 'utf8').catch(() => "[]");
      const quotes = JSON.parse(raw || "[]");
      quotes.push(entry);
      await fs.writeFile(path.join(__dirname, 'quotes.json'), JSON.stringify(quotes, null, 2));
      logger.info(`Lead saved: ${contact}`);
    } catch (fileErr) {
      logger.error(`File write error: ${fileErr.message}`);
    }

    res.json({ ok: true, message: "✅ Заявка принята! Менеджер свяжется с вами в течение часа.", leadId: Date.now().toString() });
  } catch (err) {
    logger.error(`Quote API error: ${err.message}`);
    res.status(500).json({ error: "Ошибка сохранения заявки" });
  }
});

// API: transfer-to-manager (simple persist)
app.post("/api/transfer-to-manager", async (req, res) => {
  try {
    const { contact, chatHistory } = req.body;
    if (!contact || !chatHistory) return res.status(400).json({ error: "Необходимы контакт и история чата" });

    const entry = { timestamp: new Date().toISOString(), contact, chatHistory, source: req.get('User-Agent') || 'Unknown' };
    try {
      const raw = await fs.readFile(path.join(__dirname, 'transfers.json'), 'utf8').catch(() => "[]");
      const transfers = JSON.parse(raw || "[]");
      transfers.push(entry);
      await fs.writeFile(path.join(__dirname, 'transfers.json'), JSON.stringify(transfers, null, 2));
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
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Сообщение не указано' });

    const sid = sessionId || req.ip;
    const sessionCacheKey = `session:${sid}`;
    const historyCacheKey = `history:${sid}`;

    let session = cache.get(sessionCacheKey) || { step: 'greeting', context: {}, phrase_index: 0 };
    let history = cache.get(historyCacheKey) || [{ role: 'system', content: scenario.welcome?.message || 'Здравствуйте! Я — ваш AI-консультант Entech.' }];

    history.push({ role: 'user', content: message });

    // Quick classifier (simple)
    const messageLower = message.toLowerCase();
    if (messageLower.includes('офис')) { session.context.type = 'office'; session.step = 'office_questions'; }
    else if (messageLower.includes('цех')) { session.context.type = 'workshop'; session.step = 'workshop_questions'; }
    else if (messageLower.includes('улица')) { session.context.type = 'street'; session.step = 'street_questions'; }
    else if (messageLower.includes('склад')) { session.context.type = 'warehouse'; session.step = 'warehouse_questions'; }
    else if (messageLower.includes('ваш вариант') || messageLower.includes('другое')) { session.context.type = 'custom'; session.step = 'custom_questions'; }
    else if (messageLower.includes('менеджер') || messageLower.includes('позвать')) { session.step = 'transfer_to_manager'; }

    // Parse numeric params
    const areaMatch = message.match(/(\d{1,6})\s*(м²|кв|площадь)/i);
    const heightMatch = message.match(/высота\s+(\d{1,2})\s*м/i);
    const luxMatch = message.match(/(\d{2,4})\s*лк/i);
    if (areaMatch) session.context.area = areaMatch[1];
    if (heightMatch) session.context.height = heightMatch[1];
    if (luxMatch) session.context.lux = luxMatch[1];

    const products = findProducts(message, session.context.type);
    const topProduct = products[0] || null;

    // If OpenAI not configured — fallback friendly flow
    if (!openai) {
      const fallback = scenario.welcome?.message || 'AI временно недоступен.';
      history.push({ role: 'assistant', content: fallback });
      cache.set(sessionCacheKey, session, 600);
      cache.set(historyCacheKey, history, 600);
      return res.json({ assistant: fallback, products, session: { step: session.step, context: session.context } });
    }

    // Build compact system prompt (we keep it short to avoid repeating long history)
    const sysPrompt = `Ты профессиональный AI-консультант Энтех. Цель: спросить максимум 2 параметра (площадь/высота) и предложить 1 модель из каталога с расчётом кол-ва. Контекст: ${JSON.stringify(session.context)}. Шаг: ${session.step}`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        ...history.slice(-6)
      ],
      temperature: 0.25,
      max_tokens: 350
    });

    const assistantResponse = completion?.choices?.[0]?.message?.content || 'Нет ответа от AI.';
    history.push({ role: 'assistant', content: assistantResponse });
    cache.set(sessionCacheKey, session, 600);
    cache.set(historyCacheKey, history, 600);

    logger.info(`AI response to ${sid}: ${assistantResponse.slice(0, 200)}`);
    res.json({ assistant: assistantResponse.trim(), products, session: { step: session.step, context: session.context }, tokens: completion.usage || null });
  } catch (err) {
    logger.error(`Chat API error: ${err.stack || err.message}`);
    return res.status(500).json({ error: 'Ошибка на сервере. Попробуйте позже.' });
  }
});

// root: serve widget.html if exists, else index.html
app.get('/', (req, res) => {
  const widgetPath = path.join(__dirname, 'widget.html');
  const indexPath = path.join(__dirname, 'index.html');
  try {
    fs.accessSync(widgetPath);
    return res.sendFile(widgetPath);
  } catch {}
  try {
    fs.accessSync(indexPath);
    return res.sendFile(indexPath);
  } catch {
    return res.status(404).send('UI not found');
  }
});

// health
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    catalogSize: catalog.length,
    openai: !!openai,
    uptime: process.uptime(),
    cacheSize: cache.keys().length
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server started on port ${PORT}`);
});
