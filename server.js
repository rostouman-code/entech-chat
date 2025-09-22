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
import fetch from "node-fetch";

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
  contentSecurityPolicy: false,
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
  logger.info(`${req.method} ${req.url} from ${req.ip} - User-Agent: ${req.get('User-Agent')}`);
  
  // ПОЛНОЕ УДАЛЕНИЕ CSP HEADERS
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('content-security-policy');
  res.removeHeader('X-Content-Security-Policy');
  
  // МАКСИМАЛЬНО РАЗРЕШИТЕЛЬНЫЙ CSP
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
const cache = new NodeCache({ stdTTL: 600 }); // 10 минут кэш

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

// Функция расчёта светового потока (fallback)
function calculateLumens(power_w, lumens) {
  if (!power_w || isNaN(power_w)) return null;
  const calculated = Math.round(power_w * 130); // 130 лм/Вт
  return (lumens && lumens > power_w * 100) ? lumens : calculated;
}

// Функция расчёта количества светильников
function calculateQuantity(area, targetLux, lumens, utilization = 0.6) {
  if (!area || !targetLux || !lumens) return null;
  const totalLumensNeeded = area * targetLux / utilization;
  const quantity = Math.ceil(totalLumensNeeded / lumens);
  return Math.max(1, quantity);
}

// ✅ ИСПРАВЛЕНО: Улучшенный поиск товаров с фильтрацией по категории и проверкой query
function findProducts(query, category = null) {
  // Проверка на undefined или null
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

// API: Сохранение заявки на КП
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

// ✅ ОБНОВЛЕННЫЙ API: передача диалога менеджеру
app.post("/api/transfer-to-manager", async (req, res) => {
  try {
    const { contact, chatHistory } = req.body;
    
    if (!contact || !chatHistory) {
      return res.status(400).json({ 
        error: "Необходимы контактные данные и история чата" 
      });
    }
    
    // Форматируем историю для отправки
    const formattedHistory = chatHistory.map(msg => 
      `${msg.role === 'user' ? 'Клиент:' : 'Бот:'} ${msg.content}`
    ).join('\n');
    
    const message = `Новый лид с сайта!\n\nКонтакт: ${contact}\n\nИстория диалога:\n${formattedHistory}`;
    
    // Отправка только в Telegram
    const telegramStatus = await sendToTelegram(message);

    if (telegramStatus.ok) {
        res.json({ ok: true, message: "Диалог успешно передан." });
    } else {
        res.status(500).json({ 
            ok: false, 
            error: "Ошибка при передаче. Пожалуйста, попробуйте еще раз." 
        });
    }

  } catch (err) {
    logger.error(`Transfer API error: ${err.message}`);
    res.status(500).json({ error: "Ошибка передачи диалога." });
  }
});

// ✅ НОВАЯ ФУНКЦИЯ: отправка в Telegram
async function sendToTelegram(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
        logger.error("Telegram bot token or chat ID is not set in .env");
        return { ok: false };
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.ok) {
            logger.info("Telegram message sent successfully.");
            return { ok: true };
        } else {
            logger.error(`Telegram API error: ${JSON.stringify(data.description)}`);
            return { ok: false, error: data.description };
        }
    } catch (err) {
        logger.error(`Telegram request error: ${err.message}`);
        return { ok: false, error: err.message };
    }
}


// ✅ ИСПРАВЛЕНО: API чата использует sessionId
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length < 1) {
      return res.status(400).json({ 
        error: "Сообщение не может быть пустым" 
      });
    }
    
    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId не предоставлен. Перезагрузите страницу."
      });
    }

    if (!openai) {
      return res.status(503).json({ 
        error: "AI сервис временно недоступен" 
      });
    }

    // ✅ ИСПРАВЛЕНО: Используем sessionId вместо IP
    const historyCacheKey = `chat_history:${sessionId}`;
    const sessionCacheKey = `chat_session:${sessionId}`;
    
    let history = cache.get(historyCacheKey) || [];
    let session = cache.get(sessionCacheKey) || { 
      step: 'greeting', 
      context: {}, 
      questions_asked: 0,
      phrase_index: 0 
    };

    // Обновляем историю
    history.push({ role: "user", content: message });
    if (history.length > 5) history = history.slice(-5);
    cache.set(historyCacheKey, history, 600);

    logger.info(`Chat: "${message.slice(0, 50)}..." from ${sessionId} (step: ${session.step})`);

    // Определяем шаг диалога
    const messageLower = message.toLowerCase().trim();
    if (session.step === 'greeting') {
      if (['офис', 'office'].includes(messageLower)) {
        session.context.type = 'office';
        session.step = 'office_questions';
      } else if (['цех', 'workshop', 'цеховая'].includes(messageLower)) {
        session.context.type = 'workshop';
        session.step = 'workshop_questions';
      } else if (['улица', 'street', 'уличный'].includes(messageLower)) {
        session.context.type = 'street';
        session.step = 'street_questions';
      } else if (['склад', 'warehouse'].includes(messageLower)) {
        session.context.type = 'warehouse';
        session.step = 'warehouse_questions';
      }
    }

    // ✅ ФИКС: Поддержка "ваш вариант" и нестандартных объектов
    if (session.step === 'greeting' && (
        messageLower.includes('ваш вариант') || 
        messageLower.includes('ваш вариант') ||
        messageLower.includes('стадион') || 
        messageLower.includes('парк') || 
        messageLower.includes('спорт') || 
        messageLower.includes('площадь') ||
        messageLower.includes('объект') || 
        messageLower.includes('проект') ||
        messageLower.includes('custom')
    )) {
        session.context.type = 'custom';
        session.step = 'custom_questions';
        logger.info(`Custom object detected: ${messageLower}`);
    }

    // Проверяем, есть ли достаточно параметров для рекомендации
    const hasEnoughParams = session.context.area && session.context.height && session.context.lux;
    if (hasEnoughParams && session.step.includes('_questions')) {
      session.step = `${session.context.type}_recommendation`;
    }

    // Если клиент хочет пример без уточнений
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

    // Парсим параметры из сообщения
    const areaMatch = message.match(/(\d{1,3})\s*(м²|кв|площадь)/i);
    const heightMatch = message.match(/высота\s+(\d{1,2})\s*м/i);
    const luxMatch = message.match(/(\d{2,3})\s*лк/i);
    
    if (areaMatch) session.context.area = areaMatch[1];
    if (heightMatch) session.context.height = heightMatch[1];
    if (luxMatch) session.context.lux = luxMatch[1];

    // Ищем товары по категории
    const products = findProducts(message, session.context.type);
    const topProduct = products[0]; // Берем только ТОП-1
    
    let productText = topProduct ? 
      `**ТОП МОДЕЛЬ:** ${topProduct.model} (${topProduct.power_w}Вт, ${topProduct.display_lumens}, ${topProduct.ip_rating}, ${topProduct.category})` : 
      'Поиск по параметрам';

    // ✅ ФИКС: Расширенный поиск для нестандартных объектов
    if (session.context.type === 'custom') {
      const customProducts = findProducts(message, 'all'); // Ищем по всему каталогу
      const topCustomProduct = customProducts[0];
      if (topCustomProduct) {
        productText = `**УНИВЕРСАЛЬНОЕ РЕШЕНИЕ:** ${topCustomProduct.model} (${topCustomProduct.power_w}Вт, ${topCustomProduct.display_lumens}, ${topCustomProduct.ip_rating})`;
      }
    }

    // Расчёт количества (если есть параметры)
    let quantity = null;
    if (topProduct && session.context.area && session.context.lux) {
      const lumensNum = parseInt(topProduct.display_lumens.replace('лм', '')) || 0;
      const areaNum = parseInt(session.context.area);
      const luxNum = parseInt(session.context.lux);
      quantity = calculateQuantity(areaNum, luxNum, lumensNum);
    }

    // Вариации фраз для рекомендаций
    const phraseVariations = [
      'рекомендую решение',
      'предлагаю вариант', 
      'подойдёт',
      'оптимальное решение'
    ];
    const currentPhrase = phraseVariations[session.phrase_index % phraseVariations.length];
    session.phrase_index++;

    // ✅ ФИКС: Расширенный системный промпт с поддержкой custom объектов
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

Отвечай **коротко, профессионально, как эксперт**.`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        ...history.map(msg => ({ role: msg.role, content: msg.content }))
      ],
      temperature: 0.3,
      max_tokens: 400
    });

    const assistantResponse = completion.choices[0].message.content;
    history.push({ role: "assistant", content: assistantResponse });
    
    // Сохраняем состояние сессии
    cache.set(sessionCacheKey, session, 600);
    cache.set(historyCacheKey, history, 600);

    logger.info(`AI response: ${assistantResponse.slice(0, 50)}... (${completion.usage?.total_tokens || 'N/A'} tokens)`);
    
    res.json({ 
      assistant: assistantResponse.trim(),
      session: { step: session.step, context: session.context }, // Для debug
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
    uptime: process.uptime(),
    cacheSize: cache.keys().length
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