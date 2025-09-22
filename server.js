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
  const cache