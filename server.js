// server.js
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ---------------- CORS (обязателен до роутов) ---------------- */
const allowList = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim().replace(/\/+$/, "")) // убираем хвостовые /
  .filter(Boolean);

const corsMw = cors({
  origin: (origin, cb) => {
    // Разрешаем запросы без Origin (curl/сервер)
    if (!origin) return cb(null, true);
    const clean = origin.replace(/\/+$/, "");
    if (allowList.includes(clean)) return cb(null, true);
    return cb(new Error(`CORS: origin "${origin}" is not in ALLOWED_ORIGINS`));
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400, // кэш preflight на сутки
});
app.use(corsMw);
app.options("*", corsMw); // отвечаем на любые OPTIONS

/* ---------------- Безопасность и базовые миддлвары ---------------- */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------------- Лимит запросов ---------------- */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ---------------- Статика (по желанию) ---------------- */
app.use(express.static(__dirname));

/* ---------------- Пинги и заглушки ---------------- */
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/chat", (_req, res) => res.status(405).send("Use POST /api/chat"));

/* ---------------- Каталог ---------------- */
let catalog = [];
const catalogPath = path.join(__dirname, "catalog.json");
try {
  if (fs.existsSync(catalogPath)) {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    console.log(`catalog loaded: ${catalog.length} items`);
  } else {
    console.log("catalog.json not found — подбор по каталогу будет упрощённым");
  }
} catch (e) {
  console.warn("catalog load error:", e.message);
}

/* ---------------- OpenAI ---------------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/* ---------------- Утилиты ---------------- */
function firstImage(p) {
  return p?.image_url || p?.image || "";
}
function pickProductsByText(q, limit = 3) {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  const s = (q || "").toLowerCase();
  const scored = catalog
    .map(p => {
      const hay = `${p.model} ${p.name} ${p.category}`.toLowerCase();
      let score = 0;
      if (s.includes("склад")) score += /промышлен|склад/i.test(hay) ? 2 : 0;
      if (s.includes("офис")) score += /офис/i.test(hay) ? 3 : 0;
      if (s.includes("цех")) score += /промышлен|цех/i.test(hay) ? 3 : 0;
      if (s.includes("улиц")) score += /улич/i.test(hay) ? 3 : 0;
      if (hay.includes("nrg-top")) score += 1;
      if (hay.includes("nrg-bell")) score += 1;
      if (hay.includes("nrg-ft")) score += 1;
      return { score, p };
    })
    .sort((a, b) => b.score - a.score);

  return scored.filter(x => x.score > 0).slice(0, limit).map(x => x.p);
}

/* ---------------- Основной эндпоинт чата ---------------- */
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId, utm = {}, ref = "" } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Пустое сообщение" });
    }

    if (!openai) {
      return res.status(500).json({
        error:
          "Сервер не настроен: отсутствует OPENAI_API_KEY. Обратитесь к администратору.",
      });
    }

    const prepicked = pickProductsByText(message, 3);

    const sys = [
      "Ты — специалист по подбору светильников компании Энтех.",
      "Сначала уточняй: тип помещения, площадь (м²), высота (м), требования к IP, тип монтажа.",
      "Затем кратко предложи 1–3 модели из каталога (если уместно) и поясни выбор.",
      "Отвечай по-русски, кратко и по делу.",
    ].join(" ");

    const ctxFromCatalog =
      prepicked.length > 0
        ? prepicked
            .map(
              (p, i) =>
                `${i + 1}) ${p.name || p.model} — ${p.power_w ?? "-"} Вт, ${
                  p.lumens ?? "-"
                } лм, категория: ${p.category || "-"}`
            )
            .join("\n")
        : "Подходящие модели эвристикой не найдены.";

    let aiText = "";
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content:
              `Запрос пользователя: ${message}\n` +
              `UTM: ${JSON.stringify(utm)}; ref: ${ref || "-"}`,
          },
          {
            role: "assistant",
            content:
              "Доступный контекст из каталога (может быть неполным):\n" +
              ctxFromCatalog,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      });
      aiText =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Готов помочь. Уточните: тип помещения, площадь и высота.";
    } catch (apiErr) {
      console.error("OpenAI API error:", apiErr?.message || apiErr);
      return res.status(502).json({
        error:
          "Проблема с генерацией ответа ИИ. Проверьте OPENAI_API_KEY/лимиты/модель.",
      });
    }

    res.json({
      assistant: aiText,
      products:
        prepicked?.map(p => ({
          model: p.model,
          name: p.name,
          power_w: p.power_w,
          lumens: p.lumens,
          category: p.category,
          image_url: firstImage(p),
        })) || [],
    });
  } catch (e) {
    console.error("Ошибка /api/chat:", e);
    res.status(500).json({ error: "Ошибка обработки запроса" });
  }
});

/* ---------------- Порт/старт ---------------- */
const PORT = Number(process.env.PORT) || process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 API on :${PORT} (primary URL should proxy to this port)`)
);
