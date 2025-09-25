// chat.js — компактный, устойчивый к ошибкам, рендерит картинки из catalog.json (image_base64)
(function () {
  // Если ваш виджет загружается с того же домена, используем относительные пути.
  const API_BASE = window.ENTECH_API_BASE || window.location.origin;

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const quickContainer = document.querySelector('.quick-replies');

  // session id (stable per browser)
  function getSessionId() {
    let sid = localStorage.getItem('entech-session-id');
    if (!sid) {
      sid = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,9);
      localStorage.setItem('entech-session-id', sid);
    }
    return sid;
  }
  const SESSION_ID = getSessionId();

  // render message safely
  function renderMessage(text, isBot = true) {
    if (!messagesEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'message ' + (isBot ? 'message-bot' : 'message-user');

    const cont = document.createElement('div');
    cont.className = 'message-content';
    // safe fallback and simple markdown bold
    const safeText = (text || '').toString();
    cont.innerHTML = safeText
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?:\r\n|\r|\n)/g, '<br>');
    wrap.appendChild(cont);

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    wrap.appendChild(time);

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // render products (list)
  function renderProducts(items = []) {
    // remove existing product block if present
    const old = document.getElementById('product-block');
    if (old) old.remove();
    if (!items || items.length === 0) return;

    const block = document.createElement('div');
    block.id = 'product-block';
    block.className = 'product-list';

    items.forEach(it => {
      const card = document.createElement('div');
      card.className = 'product-card';

      const img = document.createElement('img');
      img.className = 'product-image';
      img.alt = it.model || it.name || 'Фото';
      img.src = it.image_base64 || it.image || (it.image_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150"><rect width="100%" height="100%" fill="%23EEE"/><text x="50%" y="50%" font-size="14" text-anchor="middle" fill="%23999">No image</text></svg>');
      card.appendChild(img);

      const info = document.createElement('div');
      info.className = 'product-info';
      info.innerHTML = `<h4>${it.model || it.name || '—'}</h4>
        <p>Мощность: <strong>${it.power_w ? it.power_w + ' Вт' : '—'}</strong></p>
        <p>Световой поток: <strong>${it.display_lumens || 'не указан'}</strong></p>
        <p>IP: <strong>${it.ip_rating || '—'}</strong></p>`;
      // actions
      const actions = document.createElement('div');
      actions.style.marginTop = '8px';
      const addBtn = document.createElement('button');
      addBtn.className = 'action-button';
      addBtn.textContent = 'В корзину';
      addBtn.onclick = () => {
        const basket = JSON.parse(localStorage.getItem('entechBasket') || '[]');
        const copy = {...it};
        delete copy.price_rub;
        basket.push(copy);
        localStorage.setItem('entechBasket', JSON.stringify(basket));
        alert('Добавлено в корзину');
      };
      const oneClick = document.createElement('a');
      oneClick.className = 'action-button';
      oneClick.textContent = 'Заказать';
      oneClick.href = it.url || '#';
      oneClick.target = '_blank';
      oneClick.style.marginLeft = '8px';
      oneClick.style.background = '#EEE';
      oneClick.style.color = '#222';

      actions.appendChild(addBtn);
      actions.appendChild(oneClick);
      info.appendChild(actions);

      card.appendChild(info);
      block.appendChild(card);
    });

    messagesEl.parentNode.insertBefore(block, messagesEl.nextSibling);
    block.scrollIntoView({behavior: 'smooth'});
  }

  // show quick replies (from scenario.json or DOM)
  function initQuickButtons() {
    if (!quickContainer) return;
    // If scenario present, do nothing (widget HTML may already include buttons)
    // Attach events:
    const buttons = quickContainer.querySelectorAll('.quick-reply-button');
    buttons.forEach(b => {
      b.addEventListener('click', (e) => {
        const payload = b.dataset.payload;
        if (!payload) return;
        // custom option -> focus input
        if (payload === '__custom__') {
          renderMessage('✨ Хочу подобрать светильники для другого объекта', false);
          setTimeout(() => renderMessage('Опишите, пожалуйста, объект и укажите площадь/высоту (например: "склад 200 м², высота 6 м")', true), 400);
          inputEl.focus();
        } else if (payload === 'transfer_to_manager') {
          renderMessage('Хорошо — передаю менеджеру. Пожалуйста, оставьте контакт в окне запроса.', false);
          // show quick prompt
          setTimeout(() => {
            const contact = prompt('Оставьте контакт (имя + телефон/email):');
            if (contact) {
              fetch(`${API_BASE}/api/transfer-to-manager`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ contact, chatHistory: [] })
              }).then(r => r.json()).then(d => alert(d?.message || 'Отправлено')).catch(()=>alert('Ошибка'));
            }
          }, 400);
        } else {
          sendMessage(payload);
        }
      });
    });
  }

  // send message to server
  let typingTimeout = null;
  function setTyping(on) {
    if (on) {
      if (!document.getElementById('typing')) {
        const div = document.createElement('div');
        div.id = 'typing';
        div.className = 'message message-bot';
        div.innerHTML = '<div class="message-content"><span class="typing-indicator">•••</span> Печатает...</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else {
      const el = document.getElementById('typing');
      if (el) el.remove();
    }
  }

  async function sendMessage(text) {
    const message = (text || inputEl.value || '').toString().trim();
    if (!message) return;
    renderMessage(message, false);
    inputEl.value = '';
    setTyping(true);

    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message, sessionId: SESSION_ID })
      });
      const data = await resp.json();
      setTyping(false);

      if (data.error) {
        renderMessage('Ошибка: ' + (data.error || 'сервер вернул ошибку'), true);
        return;
      }

      const assistant = data.assistant || data.message || 'Нет ответа';
      renderMessage(assistant, true);

      // render found products
      const products = data.products || [];
      if (products.length) renderProducts(products);

    } catch (e) {
      setTyping(false);
      console.error(e);
      renderMessage('Ошибка связи с сервером. Попробуйте позже.', true);
    }
  }

  // events
  document.addEventListener('DOMContentLoaded', () => {
    initQuickButtons();
    // Welcome message from scenario.json (if exists)
    fetch('/scenario.json').then(r => r.json()).then(s => {
      if (s && s.welcome) {
        // show a small delay
        setTimeout(() => {
          renderMessage(s.welcome.message || 'Здравствуйте! Я — ваш AI-консультант Entech.', true);
          // render quick replies only if not already present (but our HTML has them)
        }, s.welcome.delay_ms || 800);
      }
    }).catch(() => {
      // fallback welcome
      setTimeout(() => renderMessage('Здравствуйте! Я — ваш AI-консультант Entech. Что нужно осветить?', true), 800);
    });

    if (sendBtn) sendBtn.addEventListener('click', () => sendMessage());
    if (inputEl) inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  });

  // expose quickSend for Tilda if needed
  window.entechQuickSend = sendMessage;
})();
