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
const cache = new NodeCache({ stdTTL: 300 }); // 5 минут кэш

try {
  if (fs && readFileSync) {
    catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
    scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
    logger.info(`Loaded: ${catalog.length} items, scenario OK`);
  }
} catch (err) {
  logger.error(`Load error: ${err.message}`);
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

// Функция расчёта светового потока (fallback, если lumens не указан или низкий)
function calculateLumens(power_w, lumens) {
  if (!power_w || isNaN(power_w)) return null;
  const calculated = Math.round(power_w * 130); // 130 лм/Вт
  // Если lumens низкий или null, используем расчёт
  return (lumens && lumens > power_w * 100) ? lumens : calculated;
}

// Улучшенный поиск товаров с fallback lumens
function findProducts(query) {
  const cacheKey = `search:${query.toLowerCase()}`;
  let products = cache.get(cacheKey);
  
  if (products !== undefined) {
    return products;
  }

  const q = query.toLowerCase();
  
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
    .filter(item => item.power_w && !isNaN(item.power_w) && item.ip_rating) // ФИКС: IP > 0
    .map(item => {
      let score = 0;
      const itemLower = {
        model: item.model?.toLowerCase() || '',
        name: item.name?.toLowerCase() || '',
        category: item.category?.toLowerCase() || '',
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
      
      if (keywords.ip && item.ip_rating?.toLowerCase() === `ip${keywords.ip}`) score += 4;
      
      if (itemLower.raw.includes(q)) score += 2;
      
      if (q.includes('офис')) score += 1;
      if (q.includes('улица')) score += 1;
      if (q.includes('склад') || q.includes('цех')) score += 1;
      
      const calculatedLumens = calculateLumens(item.power_w, item.lumens);
      const displayLumens = calculatedLumens ? `${calculatedLumens}лм` : 'не указан';
      
      return { 
        ...item, 
        score, 
        relevance: score > 0 ? 'high' : 'low',
        display_lumens: displayLumens
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

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
    
    try {
      let quotes = JSON.parse(await fs.readFile("quotes.json", "utf8").catch(() => "[]"));
      quotes.push(entry);
      await fs.writeFile("quotes.json", JSON.stringify(quotes, null, 2));
      logger.info(`Lead saved to file: ${contact}`);
    } catch (fileErr) {
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

// API: AI чат с рекомендациями — ФИКС: HISTORY + УСЛОВНЫЕ ВОПРОСЫ
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

    const ip = req.ip || 'unknown'; // Ключ для history (по IP)
    const historyCacheKey = `chat_history:${ip}`;
    let history = cache.get(historyCacheKey) || []; // Получаем историю
    history.push({ role: "user", content: message }); // Добавляем новый запрос
    if (history.length > 5) history = history.slice(-5); // Храним последние 5
    cache.set(historyCacheKey, history, 600); // 10 мин TTL

    logger.info(`Chat request: "${message.slice(0, 50)}..." from ${ip}`);

    // Ищем товары в каталоге (с fallback lumens)
    const products = findProducts(message);
    const topProducts = products.slice(0, 2);
    
    const productText = topProducts.length > 0 ? 
      `\n\n**📦 РЕКОМЕНДАЦИИ ИЗ КАТАЛОГА ЭНТЕХ (ТОП-${topProducts.length}):**\n` +
      topProducts.map((p, i) => 
        `${i+1}. **${p.model || 'Модель не указана'}** ` +
        `(${p.power_w || '?'}Вт, ${p.display_lumens}, ` +
        `${p.ip_rating || 'IP не указан'}, ${p.category || 'Категория не указана'})`
      ).join('\n') : '';

    // Системный промпт — ФИКС: ВАРИАЦИИ CTA, УСЛОВНЫЕ ВОПРОСЫ, ФОТО
    const sysPrompt = `Ты — профессиональный AI-консультант Энтех по светотехнике. 
Твоя цель: помочь клиенту подобрать оптимальное освещение и получить заявку на коммерческое предложение.

**ПРАВИЛА:**
1. **ВСЕГДА используй найденные товары** из каталога в рекомендациях. Для светового потока: если не указан, рассчитай по мощности (130 лм/Вт). Пример: 27Вт → 3510 лм.
2. **Если клиент упоминает**: склад/цех → промышленные IP65 150-300Вт; офис → офисные IP20 30-60Вт; улица → уличные IP65+ 50-150Вт.
3. **Задавай вопросы ТОЛЬКО если не хватает деталей** — максимум 1 уточнение, потом рекомендации. Учитывай историю диалога.
4. **Цены НЕ называй** — "менеджер рассчитает индивидуально".
5. **Всегда заканчивай CTA**: ВАРЬИРУЙ: "Хотите КП в PDF?" или "Нужно расчет освещенности?" (чередуй).
6. **Если просят фото**: "Фото светильников на сайте Энтех или в КП от менеджера".
7. **Помни контекст**: Учитывай предыдущие сообщения в диалоге (не повторяй вопросы).

**НАЙДЕННЫЕ ТОВАРЫ:**
${productText || 'Каталог не нашёл подходящих — уточни параметры (тип помещения, высота, площадь).'}

**ФОРМАТ ОТВЕТА:**
- **Введение**: "Для [помещение] рекомендую..." (учитывай контекст)
- **2 модели** с характеристиками (модель, Вт, лм, IP, категория)
- **Уточнение** (1 вопрос, если нужны детали)
- **Преимущества**: "Гарантия 5 лет, производство РФ, бесплатный расчет"
- **CTA**: "Хотите КП в PDF? Укажите телефон/email" (или вариация)

**ЗАПРОС КЛИЕНТА:** ${message}

Отвечай **конкретно, профессионально, диалогово**. Учитывай историю. Закрывай на заявку.`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: message }
      ],
      temperature: 0.3,
      max_tokens: 400
    });

    const assistantResponse = completion.choices[0].message.content;
    history.push({ role: "assistant", content: assistantResponse }); // Храним ответ
    cache.set(historyCacheKey, history, 600);

    logger.info(`AI response generated (${completion.usage?.total_tokens || 'N/A'} tokens)`);
    
    res.json({ 
      assistant: assistantResponse.trim(),
      products: topProducts,
      tokens: completion.usage || null
    });

  } catch (err) {
    logger.error(`Chat API error: ${err.message}`);
    
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
  
  try {
    if (fs && fs.accessSync) {
      fs.accessSync(indexPath);
      res.sendFile(indexPath);
    } else {
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