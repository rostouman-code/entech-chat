const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:10000' : 'https://entech-chat.onrender.com';
const messagesContainer = document.getElementById('messages');
const inputField = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
let botIsTyping = false;
// Состояние корзины
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
    delete item.price_rub; // Убираем цену
    quoteBasket.push(item);
    localStorage.setItem('entechBasket', JSON.stringify(quoteBasket));
    updateBasketUI();
}
// Запрос КП
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
            alert(`Ошибка: ${data.error || 'Не удалось отправить запрос.'}`);
        }
    } catch (e) {
        alert('Ошибка связи с сервером.');
        console.error('Quote error:', e);
    }
}
// Отображение сообщения в чате
function addMessage(text, isBot = false) {
    if (!messagesContainer) return; // Проверка на существование контейнера
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isBot ? 'bot-message' : 'user-message'}`;
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    let processedContent = text || 'Нет ответа от сервера';
    processedContent = processedContent
        .replace(/https?:\/\/[^\s]+/g, (url) => `<a href="${url}" target="_blank">${url}</a>`)
        .replace(/###\s*(.*?)\s*###/g, '<h3>$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/рекомендую[:\s]*([^\\n]+)/gi, (match, recommendation) => `<div class="recommendation-highlight">${recommendation}</div>`)
        .replace(/предлага[её]т вариант[:\s]*([^\\n]+)/gi, (match, recommendation) => `<div class="recommendation-highlight">${recommendation}</div>`)
        .replace(/оптимальное решение[:\s]*([^\\n]+)/gi, (match, recommendation) => `<div class="recommendation-highlight">${recommendation}</div>`)
        .replace(/подойд[её]т[:\s]*([^\\n]+)/gi, (match, recommendation) => `<div class="recommendation-highlight">${recommendation}</div>`);
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
    if (botIsTyping || !messagesContainer) return;
    botIsTyping = true;
    const typingIndicator = document.createElement('div');
    typingIndicator.id = 'typing-indicator';
    typingIndicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}
// Остановка анимации печати бота
function stopTyping() {
    if (!botIsTyping || !messagesContainer) return;
    botIsTyping = false;
    const typingIndicator = document.getElementById('typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}
// Отправка сообщения на сервер
async function sendMessage(message) {
    if (!message || message.trim() === '' || !messagesContainer || !inputField) return;
    addMessage(message);
    inputField.value = '';
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
        if (data.error) {
            addMessage(`Ошибка: ${data.error}`, true);
        } else {
            addMessage(data.assistant || 'Нет данных от сервера', true);
        }
    } catch (error) {
        stopTyping();
        addMessage('Ошибка связи с сервером. Попробуйте позже.', true);
        console.error('Send message error:', error);
    }
    inputField.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '➤';
    inputField.focus();
}
// Настройка кнопок
function initQuickButtons() {
    const buttons = document.querySelectorAll('.quick-reply-button');
    if (!buttons) return; // Проверка на наличие кнопок
    buttons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            const payload = button.dataset.payload;
            if (payload === '__custom__') {
                inputField.focus();
            } else {
                sendMessage(payload);
            }
        });
    });
}
// Глобальные функции для Tilda
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
    if (event.key === 'Enter' && !event.shiftKey && inputField) {
        event.preventDefault();
        sendMessage(inputField.value);
    }
};
// Инициализация
window.addEventListener('DOMContentLoaded', function() {
    if (!messagesContainer || !inputField || !sendBtn) {
        console.error('Required elements not found:', { messagesContainer, inputField, sendBtn });
        return;
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    initQuickButtons();
    inputField.addEventListener('input', function() {
        sendBtn.disabled = this.value.trim() === '';
        sendBtn.innerHTML = this.value.trim() !== '' ? '➤' : '<div class="loading"></div>';
    });
    sendBtn.addEventListener('click', () => sendMessage(inputField.value));
    inputField.addEventListener('keypress', handleKey);
    updateBasketUI();
});