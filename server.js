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

// Улучшенный поиск товаров с фильтрацией по категории
function findProducts(query, category = null) {
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


// API: AI чат с state machine + улучшенным диалогом + ФИКС "Ваш вариант"
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

    const ip = req.ip || 'unknown';
    const historyCacheKey = `chat_history:${ip}`;
    const sessionCacheKey = `chat_session:${ip}`;
    
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

    logger.info(`Chat: "${message.slice(0, 50)}..." from ${ip} (step: ${session.step})`);

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
        area: session.context.type === 'office' ? '20' : session.context.type === 'workshop' ? '100' : session.context.type === 'warehouse' ? '200' : session.context.type === 'custom' ? '1000' : '50',
        height: session.context.type === 'office' ? '3' : session.context.type === 'workshop' ? '6' : session.context.type === 'warehouse' ? '8' : session.context.type === 'custom' ? '10' : '4',
        lux: session.context.type === 'office' ? '400' : session.context.type === 'workshop' ? '200' : session.context.type === 'warehouse' ? '150' : session.context.type === 'custom' ? '200' : '200'
      };
      session.step = `${session.context.type}_recommendation`;
      logger.info('User requested example, providing dummy data');
    }
    
    // Переходим к следующему шагу (спросить параметры)
    const currentScenario = scenario.followup_questions || [];
    const currentQuestion = currentScenario[session.questions_asked] || null;
    
    if (session.step.includes('_questions') && currentQuestion) {
      session.questions_asked++;
      cache.set(sessionCacheKey, session, 600);
      return res.json({ 
        message: currentQuestion,
        buttons: (session.context.type === 'custom') ? [''] : [''],
        type: 'bot'
      });
    }

    let responseMessage;
    let products = [];
    let leadContext = {};
    let quickReplies = [];
    
    // Если есть параметры, находим продукты и делаем расчет
    if (session.step.includes('_recommendation')) {
      products = findProducts(session.context.type);
      
      let lumens = 0;
      let quantity = 0;
      
      if (products.length > 0) {
        lumens = calculateLumens(products[0].power_w, products[0].lumens);
        quantity = calculateQuantity(parseInt(session.context.area), parseInt(session.context.lux), lumens);
      }
      
      const recommendationTemplate = scenario.recommendation_template || {};
      const intro = recommendationTemplate.intro || 'Для ваших задач я нашёл несколько вариантов.';
      const note = recommendationTemplate.note || '';
      const cta = recommendationTemplate.cta || '';
      
      // Отправляем расчет и найденные продукты
      responseMessage = `${intro}\n\n`
        + `**Тип объекта:** ${session.context.type}\n`
        + `**Площадь:** ${session.context.area} м²\n`
        + `**Высота:** ${session.context.height} м\n`
        + `**Норма освещенности:** ${session.context.lux} лк\n\n`
        + `***Расчёт:***\n`
        + `Для достижения нормы понадобится **~${quantity}** светильников.\n\n`
        + `Наши специалисты готовы сделать более точный светотехнический расчет и подобрать оптимальные решения.\n\n`
        + `*${note}*\n\n`
        + `**${cta}**`;
        
      leadContext = {
        type: session.context.type,
        area: session.context.area,
        height: session.context.height,
        lux: session.context.lux,
        quantity: quantity
      };
      
      quickReplies = [
        { label: "✅ Запросить КП", payload: "Запросить коммерческое предложение" },
        { label: "Подобрать другие", payload: "Подобрать другие светильники" }
      ];
      
      session.step = 'recommendation_sent';
    } else {
      // ИИ должен отвечать, если это не предопределенный шаг
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", //"gpt-3.5-turbo-16k",
        messages: [
          {
            role: "system",
            content: `Ты — дружелюбный AI-консультант компании Entech. 
            Твоя задача — помочь клиенту подобрать светодиодные светильники для его объекта. 
            Твоя основная функция — задавать вопросы, чтобы собрать информацию для подбора (тип помещения, площадь, высота, требования к освещенности).
            Если у тебя недостаточно информации, всегда предлагай клиенту "Показать пример" или "Подобрать светильник", чтобы он мог продолжить диалог.
            Если клиент просит подбор, попробуй задать уточняющие вопросы (площадь, высота и т.д.).
            Если клиент спрашивает про каталог, всегда отправляй его на сайт, например: "Ознакомиться с каталогом можно на сайте: https://ene-rgy.ru/katalog".
            Обязательно отвечай на русском языке.
            Ты должен быть очень дружелюбным и терпеливым.
            Если клиент спрашивает о цене, всегда говори, что цена зависит от объема заказа, и предложи запросить коммерческое предложение (КП). Например: "Точная цена зависит от объема и модели. Оставьте заявку на КП, и мы подготовим расчет с учетом всех скидок!".
            `
          },
          ...history
        ],
        temperature: 0.7,
        max_tokens: 500,
        stream: false,
      });

      responseMessage = completion.choices[0].message.content;
      session.phrase_index++;

      if (messageLower.includes('цена') || messageLower.includes('стоимость')) {
          responseMessage = "Точная цена зависит от объема заказа и модели. Оставьте заявку на КП, и мы подготовим расчет с учетом всех скидок!";
          quickReplies = [
              { label: "✅ Запросить КП", payload: "Запросить коммерческое предложение" }
          ];
      }
      
      // Добавляем быстрые ответы, если это приветствие
      if (session.step === 'greeting') {
        quickReplies = scenario.welcome.quick_replies;
      }
      
      if (messageLower.includes('каталог') || messageLower.includes('прайс')) {
          responseMessage = "Ознакомиться с каталогом можно на сайте: https://ene-rgy.ru/katalog";
      }

      // Если бот сам спрашивает про параметры
      const askQuestionKeywords = ['какая площадь', 'какая высота', 'сколько светильников'];
      if (askQuestionKeywords.some(keyword => responseMessage.toLowerCase().includes(keyword))) {
          quickReplies = [
              { label: "Показать пример", payload: "Показать пример" },
              { label: "Подобрать светильник", payload: "Подобрать светильник" }
          ];
      }
    }

    cache.set(sessionCacheKey, session, 600);
    
    // Форматируем ответ
    const response = {
      message: responseMessage,
      products,
      lead_context: leadContext,
      buttons: quickReplies,
      type: 'bot'
    };

    res.json(response);
    
  } catch (err) {
    logger.error(`Chat API error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: "Произошла ошибка, попробуйте позже." });
  }
});

// Роут для виджета
app.get('/widget.js', (req, res) => {
  try {
    const widgetContent = readFileSync(path.join(__dirname, 'widget.js'), 'utf8');
    res.setHeader('Content-Type', 'text/javascript');
    res.send(widgetContent);
  } catch (err) {
    res.status(404).send('Not Found');
  }
});

// Роут для главной страницы (index.html)
app.get('/', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'index.html'));
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
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});