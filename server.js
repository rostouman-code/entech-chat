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

// Trust proxy ПЕРВЫМ! (для Render.com)
app.set('trust proxy', 1);

// Logging
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

// Helmet с ОТКЛЮЧЕННЫМ CSP (только security headers)
app.use(helmet({
  contentSecurityPolicy: false,  // ← ПОЛНОЕ ОТКЛЮЧЕНИЕ CSP
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limit ТОЛЬКО на API endpoints
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // максимум 100 запросов с IP
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' }
});
app.use('/api/', limiter);

// CORS для всех origins (Render + Tilda + localhost)
app.use(cors({
  origin: [
    '*', 
    'https://entech-chat.onrender.com', 
    'https://*.tilda.ws', 
    'https://tilda.cc', 
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Static files (index.html, CSS, etc.)
app.use(express.static(__dirname));

// Custom middleware: Логи + ПОЛНЫЙ CSP OVERRIDE
app.use((req, res, next) => {
  // Логируем запросы
  logger.info(`${req.method} ${req.url} from ${req.ip} - User-Agent: ${req.get('User-Agent')}`);
  
  // ПОЛНОЕ УДАЛЕНИЕ CSP HEADERS (Render может добавлять свои)
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('content-security-policy');
  res.removeHeader('X-Content-Security-Policy');
  
  // МАКСИМАЛЬНО РАЗРЕШИТЕЛЬНЫЙ CSP (для inline JS/CSS)
  res.setHeader('Content-Security-Policy', 
    "default-src * 'unsafe-inline' 'unsafe-eval'; " +
    "script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; " +
    "style-src * 'unsafe-inline'; " +
    "connect-src *; " +
    "img-src * data: blob:; " +
    "font-src * data:; " +
    "frame-src *; " +
    "object-src *; " +
    "media-src *; " +
    "worker-src * blob:;"
  );
  
  // Другие security headers
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  next();
});

// Load catalog & scenario
let catalog = [];
let scenario = {};
const cache = new NodeCache({ stdTTL: 300 }); // ← ФИКС: строка завершена!

try {
  // Загружаем каталог товаров
  if (fs && readFileSync) {
    catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
    scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
    logger.info(`Loaded: ${catalog.length} items, scenario OK`);
  }
} catch (err) {
  logger.error(`Load error: ${err.message}`);
  // Fallback: пустой каталог
  catalog = [];
  scenario = {};
}

// OpenAI v4 — ПРАВИЛЬНАЯ ИНИЦИАЛИЗАЦИЯ
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

// Функция расчёта светового потока (fallback, если lumens не указан)
function calculateLumens(power_w) {
  if (!power_w || isNaN(power_w)) return null;
  // Средний КПД LED: 120-150 лм/Вт. Используем 130 лм/Вт для Энтех
  return Math.round(power_w * 130);
}

// Улучшенный поиск товаров с fallback lumens
function findProducts(query) {
  const cacheKey = `search:${query.toLowerCase()}`;
  let products = cache.get(cacheKey);
  
  if (products !== undefined) {
    return products;
  }

  const q = query.toLowerCase();
  
  // Извлекаем ключевые параметры из запроса
  const keywords = {
    power: q.match(/(\d{1,3})\s*(Вт|W|ватт)/)?.[1] || null,
    ip: q.match(/ip(\d{2})/)?.[1] || null,
    category: q.includes('склад') || q.includes('цех') || q.includes('производство') || q.includes('завод') ? 'промышленные' :
              q.includes('улица') || q.includes('двор') || q.includes('парковка') || q.includes('внешнее') ? 'уличные' :
              q.includes('офис') || q.includes('кабинет') || q.includes('контора') ? 'офисные' :
              q.includes('магазин') || q.includes('торговый') || q.includes('retail') ? 'торговые' : null,
    area: q.match(/(\d{1,3})\s*(м²|кв\.м|площадь)/)?.[1] || null
  };

  // Поиск по каталогу
  products = catalog
    .map(item => {
      let score = 0;
      const itemLower = {
        model: item.model?.toLowerCase() || '',
        name: item.name?.toLowerCase() || '',
        category: item.category?.toLowerCase() || '',
        raw: (item.raw || item.description || '').toLowerCase()
      };
      
      // Точное совпадение модели (+5)
      if (itemLower.model.includes(q)) score += 5;
      
      // Совпадение по названию (+3)
      if (itemLower.name.includes(q)) score += 3;
      
      // Совпадение по категории (+4)
      if (keywords.category && itemLower.category.includes(keywords.category)) score += 4;
      
      // Совпадение по мощности (+3 если близко, +2 если примерно)
      if (keywords.power && item.power_w) {
        const targetPower = parseInt(keywords.power);
        const powerDiff = Math.abs(item.power_w - targetPower);
        if (powerDiff <= 10) score += 3;
        else if (powerDiff <= 30) score += 2;
      }
      
      // Точное совпадение IP (+4)
      if (keywords.ip && item.ip_rating?.toLowerCase() === `ip${keywords.ip}`) score += 4;
      
      // Фазовый поиск по описанию (+2)
      if (itemLower.raw.includes(q)) score += 2;
      
      // Бонус за популярные запросы
      if (q.includes('офис')) score += 1;
      if (q.includes('улица')) score += 1;
      if (q.includes('склад') || q.includes('цех')) score += 1;
      
      // Fallback lumens
      const calculatedLumens = calculateLumens(item.power_w);
      const displayLumens = item.lumens || calculatedLumens || null;
      
      return { 
        ...item, 
        score, 
        relevance: score > 0 ? 'high' : 'low',
        display_lumens: displayLumens ? `${displayLumens}лм` : 'не указан'
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // Топ-3 результата

  cache.set(cacheKey, products);
  return products;
}

// API: Сохранение заявки на КП
app.post("/api/quote", async (req, res) => {
  try {
    const { name, contact, products, message } = req.body;
    
    if (!contact) {
      return res.status(400).json({ 
        error: "Контакт обязателен для заявки" 
      });
    }

    const entry = { 
      timestamp: new Date().toISOString(),
      name: name || 'Не указан',
      contact,
      products: products || [],
      message: message || '',
      source: req.get('User-Agent') || 'Unknown'
    };
    
    // Сохраняем в файл (Render free tier может не позволить — fallback в console)
    try {
      let quotes = JSON.parse(await fs.readFile("quotes.json", "utf8").catch(() => "[]"));
      quotes.push(entry);
      await fs.writeFile("quotes.json", JSON.stringify(quotes, null, 2));
      logger.info(`Lead saved to file: ${contact}`);
    } catch (fileErr) {
      // Fallback: логируем в Winston
      logger.info('NEW LEAD:', JSON.stringify(entry, null, 2));
      logger.error(`File write error (Render limitation?): ${fileErr.message}`);
    }

    logger.info(`Lead captured: ${contact} (${products?.length || 0} products)`);
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

// API: AI чат с рекомендациями — ЕСТЕСТВЕННЫЙ ДИАЛОГ
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ 
        error: "Сообщение не может быть пустым" 
      });
    }

    if (!openai) {
      return res.status(503).json({ 
        error: "AI сервис временно недоступен" 
      });
    }

    logger.info(`Chat request: "${message.slice(0, 50)}..." from ${req.ip}`);

    // Ищем товары в каталоге (с fallback lumens)
    const products = findProducts(message);
    
    // Показываем только 2 лучших товара в промпте
    const topProducts = products.slice(0, 2);
    const productCount = topProducts.length;
    
    const productText = productCount > 0 ? 
      `\n\n**📦 РЕКОМЕНДАЦИИ ИЗ КАТАЛОГА ЭНТЕХ (ТОП-${productCount}):**\n` +
      topProducts.map((p, i) => 
        `${i+1}. **${p.model || 'Модель не указана'}** ` +
        `(${p.power_w || '?'}Вт, ${p.display_lumens}, ` +
        `${p.ip_rating || 'IP не указан'}, ${p.category || 'Категория не указана'})`
      ).join('\n') : '';

    // Системный промпт — ЕСТЕСТВЕННЫЙ ДИАЛОГ С УТОЧНЕНИЯМИ
    const sysPrompt = `Ты — профессиональный AI-консультант Энтех по светотехнике. 
Твоя цель: помочь клиенту с любым вопросом об освещении и получить заявку на КП.

**ПРАВИЛА ДИАЛОГА:**
1. **ОТВЕЧАЙ НА ЛЮБОЙ ЗАПРОС** — будь то тип помещения, технические характеристики или общий вопрос
2. **РЕКОМЕНДУЙ 1-2 ТОВАРА** из каталога (ТОП-2 по релевантности). Для светового потока: если не указан, рассчитай по мощности (130 лм/Вт). Пример: 27Вт → 3510 лм, 100Вт → 13000 лм.
3. **ПОСЛЕ РЕКОМЕНДАЦИЙ** задай 1-2 **релевантных уточняющих вопроса** в зависимости от контекста:
   - Для **цех/склад**: высота потолков (3м, 6м, 10м+), площадь (м²), тип освещения (общее/рабочие зоны)
   - Для **офис**: площадь кабинета, количество рабочих мест, тип освещения (потолочное/настольное)
   - Для **улица**: длина улицы, тип покрытия, высота установки (4м, 6м, 8м+)
   - Для **общих вопросов**: уточни тип помещения или требования
4. **НЕ называй цены** — "Менеджер рассчитает индивидуально под ваш проект"
5. **ВСЕГДА заканчивай CTA**: "Хотите КП в PDF с расчетом освещенности? Укажите телефон/email"

**НАЙДЕННЫЕ ТОВАРЫ (ТОП-2 с рассчитанным световым потоком):**
${productText || 'Каталог не нашел подходящих товаров по запросу — опиши подробнее тип помещения или требования.'}

**ФОРМАТ ОТВЕТА:**
- **Естественное введение** (1-2 предложения, отвечая на вопрос клиента)
- **1-2 конкретные рекомендации** (модели с характеристиками, включая рассчитанный лм)
- **1-2 уточняющих вопроса** (короткий нумерованный список, релевантные контексту)
- **Короткие преимущества Энтех** (гарантия 5 лет, производство РФ)
- **CTA** с призывом к действию

**ЗАПРОС КЛИЕНТА:** ${message}

Отвечай **естественно, профессионально и диалогово**. Реагируй на любой вопрос. Веди разговор к уточнению деталей и заявке.`;

    // OpenAI v4 вызов
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: sysPrompt 
        },
        { 
          role: "user", 
          content: message.trim() 
        }
      ],
      temperature: 0.3,
      max_tokens: 500,
      top_p: 0.9
    });

    const assistantResponse = completion.choices[0].message.content;

    logger.info(`AI response generated (${completion.usage?.total_tokens || 'N/A'} tokens)`);
    
    res.json({ 
      assistant: assistantResponse.trim(),
      products: topProducts, // Только топ-2 в ответе
      tokens: completion.usage || null
    });

  } catch (err) {
    logger.error(`Chat API error: ${err.message}`);
    
    // Graceful error handling
    if (err.status === 401) {
      res.status(503).json({ error: "AI сервис недоступен (проверьте API ключ)" });
    } else if (err.status === 429) {
      res.status(429).json({ error: "AI перегружен. Попробуйте через минуту." });
    } else {
      res.status(500).json({ 
        error: "Временная ошибка AI. Попробуйте перефразировать вопрос." 
      });
    }
  }
});

// Root route: отдаём index.html
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  
  // Проверяем наличие файла
  try {
    if (fs && fs.accessSync) {
      fs.accessSync(indexPath);
      res.sendFile(indexPath);
    } else {
      // Fallback: простой HTML если index.html нет
      res.send(`
        <!DOCTYPE html>
        <html><head><title>Энтех AI</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>🤖 Энтех AI Консультант</h1>
          <p>Загрузка чата...</p>
          <script>
            setTimeout(() => {
              document.body.innerHTML += '<p><a href="/index.html">Открыть чат</a></p>';
            }, 2000);
          </script>
        </body></html>
      `);
    }
  } catch (err) {
    logger.error(`Index.html not found: ${err.message}`);
    res.status(404).send('Chat interface not found. Contact administrator.');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    catalogSize: catalog.length,
    openai: !!openai,
    uptime: process.uptime()
  });
});

// 404 handler для API
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Global 404 handler
app.use((req, res) => {
  logger.warn(`404: ${req.method} ${req.url} from ${req.ip}`);
  res.status(404).json({ error: 'Page not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`Global error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Энтех AI Chat Server started on port ${PORT}`);
  logger.info(`📱 Available at: http://localhost:${PORT}`);
  logger.info(`📦 Catalog: ${catalog.length} items loaded`);
  logger.info(`🤖 OpenAI: ${openai ? 'Ready' : 'Not initialized'}`);
});