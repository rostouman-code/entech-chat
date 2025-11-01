// server.js — ENTECH API (prod minimal)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import fs from 'fs';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 1) TRUST PROXY
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// 2) CORS — ДОЛЖЕН БЫТЬ ПЕРВЫМ (до helmet/limiter/роутов)
// ---------------------------------------------------------------------------
const corsOptions = {
  origin(origin, cb) {
    // Разрешаем сервер-сервер/скрипты без Origin
    if (!origin) return cb(null, true);
    try {
      const u = new URL(origin);
      const host = u.host.toLowerCase();
      const ok =
        origin === 'https://ene-rgy.ru' ||
        origin === 'https://www.ene-rgy.ru' ||
        /\.tilda\.(ws|cc)$/i.test(host); // любые поддомены Тильды
      cb(ok ? null : new Error('CORS blocked'), ok);
    } catch {
      cb(new Error('Bad origin'), false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
  credentials: false,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ---------------------------------------------------------------------------
// 3) SECURITY / PARSERS / LOGGING
// ---------------------------------------------------------------------------
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---------------------------------------------------------------------------
// 4) RATE LIMITS (после CORS, до роутов)
// ---------------------------------------------------------------------------
const commonLimiter = rateLimit({ windowMs: 60_000, max: 100 });
const chatLimiter   = rateLimit({ windowMs: 60_000, max: 30 });
const leadLimiter   = rateLimit({ windowMs: 60_000, max: 20 });
app.use(commonLimiter);

// ---------------------------------------------------------------------------
// 5) HEALTH ROUTES
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => res.json({ ok: true, message: 'ENTECH API is running' }));
app.get('/ping', (_req, res) => res.json({ ok: true, alias: '/api/ping' }));
app.get('/api/ping', (_req, res) => res.json({ ok: true, time: Date.now() }));

// ---------------------------------------------------------------------------
// 6) CATALOG LOAD
// ---------------------------------------------------------------------------
let CATALOG = [];
try {
  CATALOG = JSON.parse(fs.readFileSync('./catalog.json', 'utf8'));
  console.log(`catalog loaded: ${CATALOG.length} items`);
} catch (e) {
  console.warn('catalog.json not loaded:', e.message);
}

// ---------------------------------------------------------------------------
// 7) PRESELECT LOGIC
// ---------------------------------------------------------------------------
function preselectProducts(params = {}) {
  const { category, area, height, ip } = params;
  const ppm =
    category === 'office' ? 10 :
    category === 'warehouse' ? 15 :
    category === 'workshop' ? 20 : 12; // W/m2 ориентир

  const need = area ? area * ppm : null;

  const normIP = (x) => String(x || '').toUpperCase();
  const minIP = normIP(ip);

  const items = CATALOG
    .filter(it => {
      if (minIP && normIP(it.ip_rating) < minIP) return false;
      if (category && it.category && it.category !== category) return false;
      return true;
    })
    .map(it => {
      let score = 0;
      if (need && it.power_w) {
        const diff = Math.abs(need - Number(it.power_w));
        score += 1200 / (1 + diff);
      }
      if (height && it.beam_angle) {
        score += height >= 6
          ? (it.beam_angle <= 90 ? 60 : 0)
          : (it.beam_angle >= 90 ? 40 : 0);
      }
      if (it.lumens) score += Math.min(Number(it.lumens) / 100, 80);
      return { ...it, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 4);

  return items;
}

// ---------------------------------------------------------------------------
// 8) SCHEMAS
// ---------------------------------------------------------------------------
const ChatSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().min(3),
  params: z.object({
    category: z.string().optional(),
    area: z.number().optional(),
    height: z.number().optional(),
    ip: z.string().optional(),
  }).partial().optional(),
});

const LeadSchema = z.object({
  name: z.string().min(1).max(100),
  contact: z.string().min(3).max(200),
  comment: z.string().max(2000).optional(),
  sessionId: z.string().min(3),
  utm: z.record(z.string()).optional(),
  referrer: z.string().optional(),
  bucket: z.array(z.object({
    model: z.string().optional(),
    id: z.any().optional(),
  })).optional(),
});

// ---------------------------------------------------------------------------
// 9) MAILER
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

// ---------------------------------------------------------------------------
// 10) API ENDPOINTS
// ---------------------------------------------------------------------------
app.post('/api/chat', chatLimiter, async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Bad input' });

  const { params = {} } = parsed.data;
  const products = preselectProducts(params);
  const reply = 'Подобрал варианты по вашим параметрам. Можно оформить КП или оставить контакты — менеджер свяжется.';
  res.json({ ok: true, reply, products });
});

app.post('/api/lead', leadLimiter, async (req, res) => {
  const parsed = LeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'Bad input' });

  const data = parsed.data;

  // Отправка письма (не падаем, если SMTP не настроен)
  try {
    const subject = `Заявка с виджета ENTECH (${new Date().toLocaleString('ru-RU')})`;
    const html = `
      <h2>Новая заявка</h2>
      <p><b>Имя:</b> ${esc(data.name)}</p>
      <p><b>Контакт:</b> ${esc(data.contact)}</p>
      ${data.comment ? `<p><b>Комментарий:</b> ${esc(data.comment)}</p>` : ''}
      <p><b>Session:</b> ${esc(data.sessionId)}</p>
      ${data.bucket?.length ? `<p><b>Выбранные модели:</b> ${data.bucket.map(b => esc(b.model || '')).join(', ')}</p>` : ''}
      <hr>
      <p><b>UTM:</b> ${esc(JSON.stringify(data.utm || {}))}</p>
      <p><b>Referrer:</b> ${esc(data.referrer || '')}</p>
    `;
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'robot@ene-rgy.ru',
      to: 'info@ene-rgy.ru',
      subject,
      html,
    });
  } catch (e) {
    console.error('MAIL ERROR:', e.message);
  }

  console.log('LEAD:', { name: data.name, contact: data.contact, sessionId: data.sessionId });
  res.json({ ok: true });
});

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

// ---------------------------------------------------------------------------
// 11) START
// ---------------------------------------------------------------------------
app.listen(PORT, () => console.log('API on :' + PORT));
