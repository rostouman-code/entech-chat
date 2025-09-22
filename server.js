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