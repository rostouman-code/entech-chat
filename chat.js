// chat.js

const chatBody = document.getElementById("chat-body");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const quickEl = document.getElementById("quick");

let scenario = {};

// Загружаем сценарий приветствия
fetch("scenario.json")
  .then((r) => r.json())
  .then((sc) => {
    scenario = sc;
    renderQuickReplies(sc.welcome.quick_replies);
    setTimeout(() => addMessage(sc.welcome.message, "bot"), sc.welcome.delay_ms);
  })
  .catch(() => {
    addMessage(
      "Здравствуйте! Подберу светильники для вашего объекта. Что нужно осветить?",
      "bot"
    );
  });

// Отправка сообщения
sendBtn.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  addMessage(text, "user");
  sendMessage(text);
  chatInput.value = "";
};

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

// Добавить сообщение в чат
function addMessage(text, sender = "bot") {
  const msg = document.createElement("div");
  msg.className = sender === "user" ? "msg user-msg" : "msg bot-msg";
  msg.textContent = text;
  chatBody.appendChild(msg);
  chatBody.scrollTop = chatBody.scrollHeight;
}

// Рендер быстрых кнопок
function renderQuickReplies(replies) {
  quickEl.innerHTML = "";
  replies.forEach((r) => {
    const btn = document.createElement("div");
    btn.className = "quick-btn";
    btn.textContent = r.label;
    btn.onclick = () => {
      if (r.payload === "__custom__") {
        addMessage("✨ Хочу подобрать светильники для другого объекта", "user");
        setTimeout(() => {
          addMessage("Опишите, пожалуйста, объект: цех, ангар, спортзал, парковка или что-то другое?", "bot");
        }, 500);
      } else {
        sendMessage(r.payload);
      }
    };
    quickEl.appendChild(btn);
  });
}

// Рендер товаров
function renderProducts(products) {
  if (!products || !products.length) return;

  const container = document.createElement("div");
  container.className = "products";

  products.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";

    const img = document.createElement("img");
    img.className = "product-img";
    img.src = p.image_url || p.image_base64 || "placeholder.png";
    card.appendChild(img);

    const title = document.createElement("div");
    title.className = "product-title";
    title.textContent = p.model || "Без названия";
    card.appendChild(title);

    if (p.description) {
      const desc = document.createElement("div");
      desc.className = "product-desc";
      desc.textContent = p.description;
      card.appendChild(desc);
    }

    container.appendChild(card);
  });

  chatBody.appendChild(container);
  chatBody.scrollTop = chatBody.scrollHeight;
}

// Отправка на сервер
async function sendMessage(message) {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    const data = await res.json();
    if (data.error) {
      addMessage("Ошибка: " + data.error, "bot");
      return;
    }

    if (data.assistant) addMessage(data.assistant, "bot");
    if (data.products) renderProducts(data.products);
  } catch (err) {
    addMessage("⚠️ Ошибка связи с сервером", "bot");
    console.error("API Error:", err);
  }
}
