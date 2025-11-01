// chat.js — безопасный фронт виджета ENTECH
// Использует API: window.ENTECH_API_BASE или дефолт на ваш Render.
// Вставляйте на страницу вместе с widget.html или адаптируйте под свою верстку.

(function(){
  'use strict';

  // --- Настройки
  const API_BASE = (window.ENTECH_API_BASE || 'https://entech-chat.onrender.com').replace(/\/+$/,'');
  const SESSION_ID = (crypto?.randomUUID?.() || String(Math.random()).slice(2)) + '-' + Date.now();

  // --- DOM ссылки (адаптируйте под свой HTML при необходимости)
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const typingEl = document.getElementById('typing');

  if (!messagesEl || !inputEl || !sendBtn) {
    console.error('[chat.js] Не найден один из обязательных элементов (#messages, #user-input, #send-btn).');
  }

  // --- Утилиты
  function esc(s=''){
    return s.toString()
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }
  function scrollBottom(){
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function setTyping(v){
    if (typingEl) typingEl.style.display = v ? 'block' : 'none';
    scrollBottom();
  }
  function addMessage(html, isBot=true){
    if (!messagesEl) return null;
    const wrap = document.createElement('div');
    wrap.className = 'message ' + (isBot ? 'message-bot' : 'message-user');
    const inner = document.createElement('div');
    inner.className = 'message-content';
    inner.innerHTML = html;
    wrap.appendChild(inner);
    messagesEl.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  // --- Лид форма
  function renderLeadForm(prefill = {}) {
    const block = document.createElement('div');
    block.className = 'message message-bot';
    block.innerHTML = `
      <div class="message-content">
        <div style="font-weight:600;margin-bottom:6px;">Оставьте контакты — перезвоним и подготовим КП</div>
        <form class="lead-form">
          <input name="name" placeholder="Имя" value="${esc(prefill.name||'')}" required>
          <input name="contact" placeholder="Телефон или email" value="${esc(prefill.contact||'')}" required>
          <textarea name="comment" placeholder="Кратко опишите задачу">${esc(prefill.comment||'')}</textarea>
          <label style="display:flex;gap:6px;align-items:flex-start;margin:6px 0;font-size:12px;color:#666;">
            <input type="checkbox" name="consent" required>
            <span>Согласен на обработку персональных данных и с <a href="/policy" target="_blank" rel="noopener">политикой ПДн</a></span>
          </label>
          <button type="submit" class="btn">Отправить</button>
        </form>
      </div>`;
    messagesEl.appendChild(block);
    scrollBottom();

    const form = block.querySelector('form.lead-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = Object.fromEntries(fd.entries());
      if (!payload.consent) return;
      delete payload.consent;

      // соберём корзину из dataset (если добавляли товары)
      payload.bucket = (()=>{ try { return JSON.parse(messagesEl.dataset.bucket||'[]'); } catch { return []; }})();

      // UTM и реферер
      payload.utm = Object.fromEntries(new URLSearchParams(location.search).entries());
      payload.referrer = document.referrer || '';

      payload.sessionId = SESSION_ID;

      setTyping(true);
      try {
        const resp = await fetch(`${API_BASE}/api/lead`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        setTyping(false);
        if (data?.ok) {
          addMessage('Спасибо! Заявка отправлена. Менеджер свяжется с вами в ближайшее время. Хотите сразу получить КП на почту?', true);
        } else {
          addMessage('Не получилось отправить заявку. Попробуйте ещё раз или позвоните по телефону на сайте.', true);
        }
      } catch (_e) {
        setTyping(false);
        addMessage('Ошибка связи. Попробуйте ещё раз.', true);
      }
    });
  }

  function requestQuote(item) {
    renderLeadForm({ comment: item ? `Нужно КП по модели: ${item.model || item.name || ''}` : '' });
  }

  function addToQuoteBasket(item) {
    if (!messagesEl.dataset.bucket) messagesEl.dataset.bucket = '[]';
    const arr = JSON.parse(messagesEl.dataset.bucket);
    arr.push({ model: item.model, id: item.id });
    messagesEl.dataset.bucket = JSON.stringify(arr);
    addMessage(`Добавил к заявке: <b>${esc(item.model || item.name || 'позиция')}</b>`, true);
  }

  // --- Рендер карточек товаров (без inline onclick)
  function renderProducts(items = []) {
    if (!items?.length) return;

    const block = document.createElement('div');
    block.className = 'message message-bot';
    const content = document.createElement('div');
    content.className = 'message-content';

    const grid = document.createElement('div');
    grid.className = 'product-list';

    items.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'product-card';

      const img = document.createElement('img');
      img.className = 'product-image';
      img.alt = esc(it.model || it.name || 'Фото');
      img.src = it.image_base64 || it.image || it.image_url ||
        'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150"><rect width="100%" height="100%" fill="%23EEE"/><text x="50%" y="50%" font-size="14" text-anchor="middle" fill="%23999">Нет фото</text></svg>';

      const info = document.createElement('div');
      info.className = 'product-info';
      info.innerHTML = `
        <div class="title">${esc(it.model || it.name || 'Светильник')}</div>
        <div class="specs">
          Мощность: ${esc(it.power_w ?? '—')} Вт<br>
          Световой поток: ${esc(it.lumens ?? '—')} лм<br>
          IP: ${esc(it.ip_rating ?? '—')}
        </div>
        <div class="actions">
          <button class="btn add-to-basket" data-idx="${idx}">В заявку</button>
          <button class="btn request-quote" data-idx="${idx}">КП по модели</button>
        </div>
      `;
      card._item = it;
      card.appendChild(img);
      card.appendChild(info);
      grid.appendChild(card);
    });

    content.appendChild(grid);
    block.appendChild(content);
    messagesEl.appendChild(block);
    scrollBottom();

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const card = btn.closest('.product-card');
      const item = card?._item;
      if (!item) return;
      if (btn.classList.contains('add-to-basket')) {
        addToQuoteBasket(item);
      } else if (btn.classList.contains('request-quote')) {
        requestQuote(item);
      }
    });
  }

  // --- Отправка сообщения на сервер (и мини-парсер параметров)
  function parseParams(text=''){
    const t = text.toLowerCase();
    const category = /офис/.test(t) ? 'office' : /склад/.test(t) ? 'warehouse'
                    : /цех|производ/.test(t) ? 'workshop' : /улиц|наруж/.test(t) ? 'street' : undefined;
    const area = (()=>{ const m = t.match(/(\d[\d\s]{0,6})\s*(?:м2|м.кв|кв\.м|квм|m2)/); return m ? Number(m[1].replace(/\s/g,'')) : undefined; })();
    const height = (()=>{ const m = t.match(/(h|высот[аеыу]?|высота)[^\d]{0,5}(\d[\d\s]{0,4})/); return m ? Number(m[2].replace(/\s/g,'')) : undefined; })();
    const ip = (()=>{ const m = t.match(/\bip\s*([0-9]{2})\b/); return m ? 'IP'+m[1] : undefined; })();
    return { category, area, height, ip };
  }

  async function sendMessage(text){
    addMessage(esc(text), false);
    setTyping(true);
    try{
      const params = parseParams(text);
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message: text, sessionId: SESSION_ID, params })
      });
      const data = await resp.json();
      setTyping(false);
      if (data?.reply) addMessage(esc(data.reply), true);
      if (Array.isArray(data?.products)) renderProducts(data.products);

      // CTA к лиду
      const cta = document.createElement('div');
      cta.className = 'message message-bot';
      cta.innerHTML = `<div class="message-content">
        Хотите, подготовим КП и перезвоним?
        <div style="margin-top:6px;"><button class="btn" id="lead-open">Оставить контакты</button></div>
      </div>`;
      messagesEl.appendChild(cta);
      scrollBottom();
      cta.querySelector('#lead-open').addEventListener('click', ()=> renderLeadForm({}));
    }catch(e){
      setTyping(false);
      addMessage('Сервис временно недоступен. Попробуйте позже.', true);
      console.error(e);
    }
  }

  // --- Приветствие
  addMessage(
    'Привет! Я помогу подобрать светильники под ваши параметры. ' +
    'Напишите: тип помещения (офис/склад/цех/улица), площадь и высоту потолка.',
    true
  );

  // --- События UI
  sendBtn?.addEventListener('click', () => {
    const v = inputEl.value.trim();
    if (!v) return;
    inputEl.value = '';
    sendMessage(v);
  });
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

})();
