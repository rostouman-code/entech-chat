// chat.js
const API_BASE = 'http://localhost:3000';
const messagesContainer = document.getElementById('messages');
const inputField = document.getElementById('messageInput');
const inputForm = document.getElementById('message-form'); // Если форма есть
const sendBtn = document.getElementById('sendBtn');
let botIsTyping = false;

// Состояние корзины для виджета и основной страницы
let quoteBasket = JSON.parse(localStorage.getItem('entechBasket')) || [];

// Обновление UI корзины
function updateBasketUI() {
    const basketCountEl = document.getElementById('basket-count');
    const basketEl = document.getElementById('basket-container');
    if (basketCountEl) {
        basketCountEl.textContent = quoteBasket.length;
    }
    if (basketEl) {
        basketEl.style.display = quoteBasket.length ? 'block' : 'none';
    }
}

// Добавление товара в корзину
function addToQuoteBasket(item) {
    // Убираем цену, если она есть
    delete item.price_rub;
    quoteBasket.push(item);
    localStorage.setItem('entechBasket', JSON.stringify(quoteBasket));
    updateBasketUI();
}

// Запрос КП (пока с alert)
async function requestQuote() {
    if (quoteBasket.length === 0) {
        alert('Добавьте товары в корзину!');
        return;
    }
    const contact = prompt('Оставьте контакт (имя + телефон/email):');
    if (!contact) return;
    try {
        const res = await fetch(`${API_BASE}/api/quote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact, items: quoteBasket, note: 'Запрос из виджета (цена по согласованию)' })
        });
        const data = await res.json();
        if (data.ok) {
            alert('Запрос отправлен! Менеджер согласует цену и свяжется в течение часа.');
            quoteBasket = [];
            localStorage.removeItem('entechBasket');
            updateBasketUI();
        } else {
            alert('Ошибка отправки.');
        }
    } catch (e) {
        alert('Ошибка связи.');
        console.error(e);
    }
}

// Отображение сообщения в чате
function addMessage(text, isBot = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isBot ? 'bot-message' : 'user-message'}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = `message-content`;

    let processedContent = text;
    // ... ваш код для замены ссылок и выделения рекомендаций остается без изменений
    processedContent = processedContent
        .replace(/https?:\/\/[^\s]+/g, (url) => `<a href="${url}" target="_blank">${url}</a>`)
        .replace(/###\s*(.*?)\s*###/g, "<h3>$1</h3>")
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/рекомендую[:\s]*([^\\n]+)/gi, function(match, recommendation) {
            return `<div class="recommendation-highlight">${recommendation}</div>`;
        })
        .replace(/предлага[её] вариант[:\s]*([^\\n]+)/gi, function(match, recommendation) {
            return `<div class="recommendation-highlight">${recommendation}</div>`;
        })
        .replace(/оптимальное решение[:\s]*([^\\n]+)/gi, function(match, recommendation) {
            return `<div class="recommendation-highlight">${recommendation}</div>`;
        })
        .replace(/подойд[её]т[:\s]*([^\\n]+)/gi, function(match, recommendation) {
            return `<div class="recommendation-highlight">${recommendation}</div>`;
        });

    contentDiv.innerHTML = processedContent;
    messageDiv.appendChild(contentDiv);

    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageDiv.appendChild(timeDiv);

    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Запуск анимации печати бота
function startTyping() {
    if (botIsTyping) return;
    botIsTyping = true;
    const typingIndicator = document.createElement('div');
    typingIndicator.id = 'typing-indicator';
    typingIndicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Остановка анимации печати бота
function stopTyping() {
    if (!botIsTyping) return;
    botIsTyping = false;
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}

// Отправка сообщения на сервер
async function sendMessage(message) {
    if (message.trim() === '') return;
    addMessage(message);
    inputField.value = '';
    
    // Временно отключаем поле ввода и кнопку
    inputField.disabled = true;
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<div class="loading"></div>';
    
    startTyping();
    try {
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await response.json();
        stopTyping();
        if (data.message) {
            addMessage(data.message, true);
        }
    } catch (error) {
        stopTyping();
        console.error('Error sending message:', error);
        addMessage('Произошла ошибка. Пожалуйста, попробуйте еще раз.', true);
    }
    
    // Включаем поле ввода и кнопку обратно
    inputField.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '➤';
    
    // Возвращаем фокус на поле ввода
    inputField.focus();
}

// Настройка кнопок
function initQuickButtons() {
    document.querySelectorAll('.quick-reply-button').forEach(button => {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            const payload = e.target.dataset.payload;
            if (payload === '__custom__') {
                inputField.focus();
            } else {
                sendMessage(payload);
            }
        });
    });
}

// ГЛОБАЛЬНЫЕ ФУНКЦИИ для Tilda (позволяют вызывать их из HTML)
window.quickSend = function(text) {
    sendMessage(text);
};

window.requestQuote = async function() {
    await requestQuote();
};

window.addMsg = function(content, sender) {
    addMessage(content, sender === 'assistant');
};

window.handleKey = function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(inputField.value);
    }
};

window.addEventListener('DOMContentLoaded', function() {
    const messages = document.getElementById('messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    
    // Инициализация кнопок
    initQuickButtons();
    
    // Логика для кнопки "Отправить"
    if (inputField && sendBtn) {
        inputField.addEventListener('input', function() {
            sendBtn.disabled = this.value.trim() === '';
            if (this.value.trim() !== '') {
                sendBtn.innerHTML = '➤';
            }
        });
    }
});