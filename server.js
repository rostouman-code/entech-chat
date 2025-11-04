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
  .map((s) => s.trim().replace(/\/+$/, "")) // убираем хвостовые /
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

/* ---------------- Утилиты для подбора ---------------- */
function firstImage(p) {
  return p?.image_url || p?.image || "";
}

// простой эвристический подбор из каталога по ключевым словам
function pickProductsByText(q, limit = 3) {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  const s = (q || "").toLowerCase();
  const scored = catalog
    .map((p) => {
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

  return scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.p);
}

/* ---------------- Вспомогательные функции для расчёта ---------------- */
// выбор целевой освещённости
function pickTargetLux(userText = "") {
  const s = (userText || "").toLowerCase();
  if (/(пикинг|комплектац|отбор|packing|picking)/i.test(s)) return 300; // 300 лк
  if (/(рабочие места|участок|станки|монтаж|сборка)/i.test(s)) return 500; // 500 лк
  return 200; // склад — общие зоны
}

// оценка светового потока на светильник
function estimateLumensPerFixture(p) {
  if (p?.lumens && Number(p.lumens) > 0) return Number(p.lumens);

  const power = Number(p?.power_w) || 0;
  const name = `${p?.name || ""} ${p?.model || ""}`.toLowerCase();

  let eff = 150; // дефолт
  if (/nrg\-top|top|high\s*bay/i.test(name)) eff = 180; // high-bay
  else if (/nrg\-ft|ft|linear/i.test(name)) eff = 155; // линейные

  if (power > 0) return power * eff;

  return 27000; // безопасный дефолт (≈150 Вт * 180 лм/Вт)
}

// расчёт количества светильников
function estimateCount(areaM2, targetLux, lmPerFixture, cu = 0.6, mf = 0.8) {
  if (!areaM2 || !targetLux || !lmPerFixture) return 0;
  const maintainedLumensNeeded = areaM2 * targetLux; // лм на рабочей поверхности
  const initialLumensNeeded = maintainedLumensNeeded / (cu * mf);
  return Math.max(1, Math.round(initialLumensNeeded / lmPerFixture));
}

// вытаскиваем площадь из текста
function extractAreaM2(s = "") {
  const txt = String(s).replace(",", ".");
  const m = txt.match(/(\d+(?:\.\d+)?)\s*(?:м2|м²|m2|sqm|кв\.?\s*м)/i);
  if (m) return Math.round(parseFloat(m[1]));
  const n = txt.match(/(\d+(?:\.\d+)?)/);
  if (n) {
    const val = parseFloat(n[1]);
    if (val > 30) return Math.round(val);
  }
  return null;
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

    // эвристический подбор моделей
    const prepicked = pickProductsByText(message, 3);

    // --- подготовка расчёта для модели и пользователя ---
    const areaM2 = extractAreaM2(message);
    const Ltarget = pickTargetLux(message);

    const calcItems = (prepicked || []).map((p) => {
      const lm = estimateLumensPerFixture(p);
      const qty = areaM2 ? estimateCount(areaM2, Ltarget, lm) : null;
      return {
        title: p.name || p.model || "Модель",
        power_w: p.power_w || null,
        lumens: Math.round(lm),
        qty,
      };
    });

    const ctxFromCatalog =
      prepicked && prepicked.length
        ? prepicked
            .map(
              (p, i) =>
                `${i + 1}) ${p.name || p.model} — ${p.power_w ?? "-"} Вт, ~${Math.round(
                  estimateLumensPerFixture(p)
                ).toLocaleString("ru-RU")} лм, категория: ${p.category || "-"}`
            )
            .join("\n")
        : "Подходящие модели эвристикой не найдены.";

    const calcNote =
      calcItems && calcItems.length
        ? [
            `Целевой уровень освещённости (лк): ${Ltarget}`,
            areaM2 ? `Площадь: ${areaM2} м²` : "Площадь не распознана из текста",
            ...calcItems.map(
              (it, i) =>
                `${i + 1}) ${it.title}: ориентир ~${it.lumens.toLocaleString(
                  "ru-RU"
                )} лм/шт` + (it.qty ? ` → количество ≈ ${it.qty} шт` : "")
            ),
          ].join("\n")
        : "Нет данных для расчёта количества.";

    // --- системная подсказка для модели (структурированный ответ + CTA) ---
    const sys = [
      "Ты — специалист по подбору светильников компании Энтех.",
      "Структура ответа:",
      "1) Короткое подтверждение понимания задачи (1 фраза).",
      "2) Рекомендация 1–3 моделей: название, тип монтажа, IP, ориентировочная эффективность/лм.",
      "3) Быстрый расчёт количества по площади и по целевому уровню освещённости:",
      "   - склад общая зона: 200 лк; пикинг/комплектация: 300 лк; рабочие места: 500 лк.",
      "   - используй CU≈0.6 и MF≈0.8; округляй числа; пиши «≈ N шт».",
      "4) Короткий вывод: почему именно эти модели.",
      "5) CTA: попроси длину×ширину, схему проходов/рядов и предложи коммерческое предложение с ценами/сроками.",
      "Отвечай по-русски, кратко и по делу.",
    ].join(" ");

    // --- вызов модели ---
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
              (areaM2 ? `Распознана площадь: ${areaM2} м²\n` : "") +
              `UTM: ${JSON.stringify(utm)}; ref: ${ref || "-"}`,
          },
          {
            role: "assistant",
            content:
              "Контекст из каталога (может быть неполным):\n" + ctxFromCatalog,
          },
          {
            role: "assistant",
            content: "Черновой инженерный расчёт (ориентиры):\n" + calcNote,
          },
        ],
        temperature: 0.3,
        max_tokens: 700,
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

    // --- ответ фронту ---
    res.json({
      assistant: aiText,
      products:
        prepicked?.map((p) => ({
          model: p.model,
          name: p.name,
          power_w: p.power_w,
          lumens: p.lumens || Math.round(estimateLumensPerFixture(p)),
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
