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

// Trust proxy for Render.com
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

// Helmet with permissive CSP
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limit for API endpoints
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per IP
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' }
});
app.use('/api/', limiter);

// CORS for specific origins
app.use(cors({
  origin: [
    'https://entech-chat.onrender.com',
    'https://*.tilda.ws',
    'https://tilda.cc',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Static files (widget.html, chat.js, styles.css, favicon.ico)
app.use(express.static(__dirname));

// Custom middleware: Logging + CSP override
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} from ${req.ip} - User-Agent: ${req.get('User-Agent')}`);
  
  // Remove existing CSP headers
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('content-security-policy');
  res.removeHeader('X-Content-Security-Policy');
  
  // Permissive CSP
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
  
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  next();
});

// Load catalog & scenario
let catalog = [];
let scenario = {};
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes cache

try {
  catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
  scenario = JSON.parse(readFileSync("scenario.json", "utf8"));
  logger.info(`Loaded: ${catalog.length} items, scenario OK`);
} catch (err) {
  logger.error(`Load error: ${err.message}`);
  catalog = [];
  scenario = {};
}

// OpenAI initialization
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

// Calculate lumens (fallback)
function calculateLumens(power_w, lumens) {
  if (!power_w || isNaN(power_w)) return null;
  const calculated = Math.round(power_w * 130); // 130 lm/W
  return (lumens && lumens > power_w * 100) ? lumens : calculated;
}

// Calculate quantity
function calculateQuantity(area, targetLux, lumens, utilization = 0.6) {
  if (!area || !targetLux || !lumens) return null;
  const totalLumensNeeded = area * targetLux / utilization;
  const quantity = Math.ceil(totalLumensNeeded / lumens);
  return Math.max(1, quantity);
}

// Product search
function findProducts(query, category = null) {
  if (!query) {
    logger.warn('findProducts called with empty query.');
    return [];
  }
  
  const cacheKey = `search:${query.toLowerCase()}:${category || 'all'}`;
  let products = cache.get(cacheKey);
  
  if (products !== undefined) {
    return products;
  }

  const q = query.toLowerCase();
  
  const keywords = {
    power: q.match(/(\d{1,3})\s*(Вт|W|ватт)/)?.[1] || null,
    ip: q.match(/ip(\d{2})/)?.[1] || null,
    category: category || (
      q.includes('склад') || q.includes('цех') || q.includes('производство') || q.includes('завод') ? 'промышленные' :
      q.includes('улица') || q.includes('двор') || q.includes('парковка') || q.includes('внешнее') ? 'уличные' :
      q.includes('офис') || q.includes('кабинет') || q.includes('контора') ? 'офисные' :
      q.includes('магазин') || q.includes('торговый') || q.includes('retail') ? 'торговые' : null
    ),
    area: q.match(/(\d{1,3})\s*(м²|кв\.м|площадь)/)?.[1] || null
  };

  products = catalog
    .filter(item => item.power_w && !isNaN(item.power_w) && item.ip_rating)
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

// API: Save quote
app.post("/api/quote", async (req, res) => {
  try {
    const { name, contact, products, message, context } = req.body;
    
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
      context: context || {},
      source: req.get('User-Agent') || 'Unknown'
    };
    
    try {
      let quotes = JSON.parse(await fs.readFile("quotes.json", "utf8").catch(() => "[]"));
      quotes.push(entry);
      await fs.writeFile("quotes.json", JSON.stringify(quotes, null, 2));
      logger.info(`Lead saved: ${contact} (${JSON.stringify(context)})`);
    } catch (fileErr) {
      logger.info('NEW LEAD:', JSON.stringify(entry, null, 2));
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

// API: Transfer to manager
app.post("/api/transfer-to-manager", async (req, res) => {
  try {
    const { contact, chatHistory } = req.body;
    
    if (!contact || !chatHistory) {
      return res.status(400).json({ 
        error: "Необходимы контактные данные и история чата" 
      });
    }

    const entry = {
      timestamp: new Date().toISOString(),
      contact,
      chatHistory,
      source: req.get('User-Agent') || 'Unknown'
    };

    try {
      let transfers = JSON.parse(await fs.readFile("transfers.json", "utf8").catch(() => "[]"));
      transfers.push(entry);
      await fs.writeFile("transfers.json", JSON.stringify(transfers, null, 2));
      logger.info(`Transfer saved: ${contact}`);
    } catch (fileErr) {
      logger.info('NEW TRANSFER:', JSON.stringify(entry, null, 2));
      logger.error(`File write error: ${fileErr.message}`);
    }

    res.json({ 
      ok: true, 
      message: "✅ Запрос передан менеджеру. Ожидайте звонка в течение часа."
    });
  } catch (err) {
    logger.error(`Transfer API error: ${err.message}`);
    res.status(500).json({ error: "Ошибка передачи запроса" });
  }
});

// API: Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Сообщение не указано' });
    }

    const messageLower = message.toLowerCase();
    const sessionCacheKey = `session:${req.ip}`;
    const historyCacheKey = `history:${req.ip}`;
    
    let session = cache.get(sessionCacheKey) || {
      step: 'greeting',
      context: {},
      phrase_index: 0
    };
    let history = cache.get(historyCacheKey) || [
      { role: 'system', content: scenario.welcome?.message || 'Здравствуйте! Я — ваш AI-консультант Entech.' }
    ];
    
    history.push({ role: 'user', content: message });

    if (messageLower.includes('офис')) {
      session.context.type = 'office';
      session.step = 'office_questions';
    } else if (messageLower.includes('цех')) {
      session.context.type = 'workshop';
      session.step = 'workshop_questions';
    } else if (messageLower.includes('улица')) {
      session.context.type = 'street';
      session.step = 'street_questions';
    } else if (messageLower.includes('склад')) {
      session.context.type = 'warehouse';
      session.step = 'warehouse_questions';
    } else if (messageLower.includes('ваш вариант') || messageLower.includes('другое')) {
      session.context.type = 'custom';
      session.step = 'custom_questions';
    } else if (messageLower.includes('менеджер') || messageLower.includes('позвать')) {
      session.step = 'transfer_to_manager';
    }

    if (messageLower.includes('рекоменд') || messageLower.includes('предлож')) {
      session.step = `${session.context.type}_recommendation`;
    }

    if (messageLower.includes('пример') || messageLower.includes('покажи')) {
      session.context = {
        ...session.context,
        area: session.context.type === 'office' ? '20' : 
              session.context.type === 'workshop' ? '100' : 
              session.context.type === 'warehouse' ? '200' :
              session.context.type === 'custom' ? '1000' :
              '50',
        height: session.context.type === 'office' ? '3' : 
                session.context.type === 'workshop' ? '6' : 
                session.context.type === 'warehouse' ? '8' :
                session.context.type === 'custom' ? '10' :
                '4',
        lux: session.context.type === 'office' ? '400' : 
             session.context.type === 'workshop' ? '300' : 
             session.context.type === 'warehouse' ? '150' :
             session.context.type === 'custom' ? '200' :
             '10'
      };
      session.step = `${session.context.type}_recommendation`;
    }

    const areaMatch = message.match(/(\d{1,3})\s*(м²|кв|площадь)/i);
    const heightMatch = message.match(/высота\s+(\d{1,2})\s*м/i);
    const luxMatch = message.match(/(\d{2,3})\s*лк/i);
    
    if (areaMatch) session.context.area = areaMatch[1];
    if (heightMatch) session.context.height = heightMatch[1];
    if (luxMatch) session.context.lux = luxMatch[1];

    const products = findProducts(message, session.context.type);
    const topProduct = products[0];
    
    let productText = topProduct ? 
      `**ТОП МОДЕЛЬ:** ${topProduct.model} (${topProduct.power_w}Вт, ${topProduct.display_lumens}, ${topProduct.ip_rating}, ${topProduct.category})` : 
      'Поиск по параметрам';

    if (session.context.type === 'custom') {
      const customProducts = findProducts(message, 'all');
      const topCustomProduct = customProducts[0];
      if (topCustomProduct) {
        productText = `**УНИВЕРСАЛЬНОЕ РЕШЕНИЕ:** ${topCustomProduct.model} (${topCustomProduct.power_w}Вт, ${topCustomProduct.display_lumens}, ${topCustomProduct.ip_rating})`;
      }
    }

    let quantity = null;
    if (topProduct && session.context.area && session.context.lux) {
      const lumensNum = parseInt(topProduct.display_lumens.replace('лм', '')) || 0;
      const areaNum = parseInt(session.context.area);
      const luxNum = parseInt(session.context.lux);
      quantity = calculateQuantity(areaNum, luxNum, lumensNum);
    }

    const phraseVariations = [
      'рекомендую решение',
      'предлагаю вариант', 
      'подойдёт',
      'оптимальное решение'
    ];
    const currentPhrase = phraseVariations[session.phrase_index % phraseVariations.length];
    session.phrase_index++;

    const sysPrompt = `Ты — профессиональный AI-консультант Энтех по светотехнике. ЦЕЛЬ: собрать параметры → дать 1 персонализированное решение → получить лид.

**СТРОГОЕ ПРАВИЛО: ТОЛЬКО 1 РЕКОМЕНДАЦИЯ! Никаких списков, номеров или блоков "Из каталога".**

**ЛОГИКА ДИАЛОГА:**
1. **greeting**: "Привет! Какое помещение? (офис/цех/улица/склад)"
2. **office_questions**: Максимум 2 вопроса: площадь, высота. Коротко!
3. **workshop_questions**: Тип работ, площадь. НЕ ПОВТОРЯЙ из истории!
4. **street_questions**: Тип (дорога/парковка), длина. По нормам: дороги — 15лк
5. **warehouse_questions**: Высота, стеллажи, площадь
6. **custom_questions**: Тип объекта (стадион/парк), площадь, тип освещения
7. **recommendation**: ТОЛЬКО когда есть параметры → 1 решение с расчётом
8. **close**: CTA на PDF

**КОНТЕКСТ ИЗ ИСТОРИИ:**
${JSON.stringify(session.context)}

**ТЕКУЩИЙ ШАГ:** ${session.step}

**ПАРАМЕТРЫ ПО ТИПУ:**
- ОФИС: area (м²), height (2-4м), lux (300-500)
- ЦЕХ: area (м²), height (4-8м), lux (200-750), type (грубые/точные)
- УЛИЦА: length/width (м), lux (5-20), type (дорога/парковка)
- СКЛАД: area (м²), height (6-12м), lux (75-200), shelves (есть/нет)
- **ВАШ ВАРИАНТ/custom**: тип объекта (стадион/парк/площадь), area (м²/м), lighting_type (функциональное/декоративное), lux (50-500)

**ДОПОЛНИТЕЛЬНЫЕ ТИПЫ:**
- **ВАШ ВАРИАНТ/custom**: стадион, парк, площадь, спорткомплекс, архитектурный объект
  - Вопросы: тип объекта, площадь/длина, высота/тип освещения (функциональное/декоративное)
  - Модели: универсальные (IP65+, 100-500Вт) или архитектурные из каталога
  - Пример: "Для стадиона рекомендую прожекторы NRG-TOP с регулируемым углом"

**РЕКОМЕНДАЦИИ — СТРОГО:**
- ТОЛЬКО 1 модель: ${productText}
- Расчёт: количество = (area × lux) / (lumens × 0.6)
- ФОРМАТ: "Для [параметры] [фраза]: [модель] ([кол-во] шт.)"

**ТЕКУЩАЯ ФРАЗА:** "${currentPhrase}"

**ЗАПРОС:** ${message}

**ФОРМАТ ОТВЕТА:**
- custom_questions: "Расскажите о вашем объекте: тип (стадион/парк)? Площадь/длина? Тип освещения (функциональное/декоративное)?"
- custom_recommendation: "Для [объект] [фраза]: [универсальная модель] ([кол-во] шт.) + CTA"
- Всегда: Гарантия 5 лет, производство РФ

**АКЦИЯ:** Скидка на расчёт до 30.09.2025

Отвечай **коротко, профессионально, как эксперт**.`;

    let assistantResponse;
    if (!openai) {
      assistantResponse = scenario.welcome?.message || 'AI недоступен. Попробуйте позже или свяжитесь с менеджером.';
      history.push({ role: 'assistant', content: assistantResponse });
      cache.set(sessionCacheKey, session, 600);
      cache.set(historyCacheKey, history, 600);
      logger.warn('OpenAI unavailable, using fallback response');
      return res.json({ 
        assistant: assistantResponse.trim(),
        session: { step: session.step, context: session.context },
        tokens: null
      });
    }

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        ...history.map(msg => ({ role: msg.role, content: msg.content }))
      ],
      temperature: 0.3,
      max_tokens: 400
    }).catch(err => {
      throw err; // Propagate error to outer catch
    });

    assistantResponse = completion.choices[0].message.content;
    history.push({ role: "assistant", content: assistantResponse });
    
    cache.set(sessionCacheKey, session, 600);
    cache.set(historyCacheKey, history, 600);

    logger.info(`AI response: ${assistantResponse}`);
    
    res.json({ 
      assistant: assistantResponse.trim(),
      session: { step: session.step, context: session.context },
      tokens: completion.usage || null
    });
  } catch (err) {
    logger.error(`Chat API error: ${err.message}`);
    assistantResponse = scenario.welcome?.message || 'AI временно недоступен. Попробуйте позже или свяжитесь с менеджером.';
    history.push({ role: 'assistant', content: assistantResponse });
    cache.set(sessionCacheKey, session, 600);
    cache.set(historyCacheKey, history, 600);

    if (err.status === 401) {
      res.status(503).json({ error: "AI сервис недоступен (проверьте API ключ)" });
    } else if (err.status === 429) {
      res.status(429).json({ error: "AI перегружен. Попробуйте через минуту." });
    } else {
      res.status(500).json({ error: "Временная ошибка AI. Попробуйте перефразировать вопрос." });
    }
  }
});

// Root route: Serve widget.html
app.get('/', (req, res) => {
  const widgetPath = path.join(__dirname, 'widget.html');
  try {
    if (fs && fs.accessSync) {
      fs.accessSync(widgetPath);
      res.sendFile(widgetPath);
    } else {
      res.send(`
        <!DOCTYPE html>
        <html><head><title>Энтех AI</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>🤖 Энтех AI Консультант</h1>
          <p>Загрузка чата...</p>
          <script>
            setTimeout(() => {
              document.body.innerHTML += '<p><a href="/widget.html">Открыть чат</a></p>';
            }, 2000);
          </script>
        </body></html>
      `);
    }
  } catch (err) {
    logger.error(`widget.html not found: ${err.message}`);
    res.status(404).send('Chat interface not found. Contact administrator.');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const filesExist = {
    widget: false,
    chat: false,
    styles: false,
    favicon: false
  };
  try {
    fs.accessSync(path.join(__dirname, 'widget.html'));
    filesExist.widget = true;
  } catch {}
  try {
    fs.accessSync(path.join(__dirname, 'chat.js'));
    filesExist.chat = true;
  } catch {}
  try {
    fs.accessSync(path.join(__dirname, 'styles.css'));
    filesExist.styles = true;
  } catch {}
  try {
    fs.accessSync(path.join(__dirname, 'favicon.ico'));
    filesExist.favicon = true;
  } catch {}

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    catalogSize: catalog.length,
    openai: !!openai,
    uptime: process.uptime(),
    cacheSize: cache.keys().length,
    files: filesExist
  });
});

// 404 handler for API
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
  // For Render.com free tier: Set up a cron-job (e.g., UptimeRobot) to ping /health every 10 min to prevent sleep
});