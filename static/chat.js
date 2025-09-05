// =================== Local State ===================
let sessions = JSON.parse(localStorage.getItem("sessions")) || {};
let currentSessionId = localStorage.getItem("currentSessionId") || null;
let sessionMode = "normal";
let incognitoSessions = {};
let translations = {};

// =================== DOM Elements ===================
const sessionList     = document.getElementById("sessionList");
const chatBox         = document.getElementById("chatBox");
const messageInput    = document.getElementById("messageInput");
const sendBtn         = document.getElementById("sendBtn");
const newSessionBtn   = document.getElementById("newSessionBtn");
const modeSelector    = document.getElementById("modeSelector");
const incognitoBanner = document.getElementById("incognitoBanner");
const languageSelector = document.getElementById("languageSelector");

// =================== Enable/Disable Input ===================
function setInputEnabled(on) {
  if (!messageInput || !sendBtn) return;
  messageInput.disabled = !on;
  sendBtn.disabled = !on;
  if (on) setTimeout(() => messageInput.focus(), 0);
}

// =================== i18n ===================
async function loadTranslations(lang) {
  try {
    const res = await fetch(`/static/lang/${lang}.json`);
    if (!res.ok) throw new Error("Could not load translations");
    translations = await res.json();
    applyTranslations();
    localStorage.setItem("selectedLanguage", lang);
  } catch (err) {
    console.warn("Could not load language file:", lang, err);
    translations = {}; // fallback to empty object
  }
}

function applyTranslations() {
  if (!translations || typeof translations !== "object") return;

  // Update welcome message
  const wm = document.getElementById("welcomeMessage");
  if (wm) {
    const welcome = translations["welcome_message"] || "Welcome to your personal chat.";
    const prompt  = translations["start_prompt"] || "Please create a new session below to begin.";
    wm.innerHTML = `${welcome}<br>${prompt}`;
  }

  // Translate all elements with data-i18n
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const value = translations[key];
    if (!value) return; // ✅ skip missing keys
    if (["input","textarea"].includes(el.tagName.toLowerCase())) {
      el.placeholder = value;
    } else {
      el.textContent = value;
    }
  });

  // Translate placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    const value = translations[key];
    if (value) el.setAttribute("placeholder", value);
  });

  // Handle RTL languages
  const lang = localStorage.getItem("selectedLanguage") || "en";
  document.body.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

// =================== Mode Switch ===================
modeSelector.addEventListener("change", () => {
  sessionMode = modeSelector.value;
  currentSessionId = null;
  incognitoBanner.style.display = sessionMode === "incognito" ? "block" : "none";
  renderSessions();
  renderMessages(null);
  setInputEnabled(false);
  if (sessionMode === "normal") saveState();
});

// =================== Persistence ===================
function saveState() {
  if (sessionMode === "normal") {
    localStorage.setItem("sessions", JSON.stringify(sessions));
    localStorage.setItem("currentSessionId", currentSessionId || "");
  }
}

function persistToDB(id) {
  try {
    const s = sessions[id];
    if (!s) return;
    fetch("/sessions/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        session_id: id,
        name: s.name || "Session",
        messages: s.messages || [],
        kind: "chat"
      })
    }).catch(() => {});
  } catch (_) {}
}

// =================== Render ===================
function renderSessions() {
  sessionList.innerHTML = "";
  const source = sessionMode === "normal" ? sessions : incognitoSessions;

  Object.entries(source).forEach(([id, session]) => {
    const li = document.createElement("li");
    li.className = currentSessionId === id ? "active" : "";
    li.innerHTML = `
      <span class="session-title">${session.name || "Unnamed Session"}</span>
      <div class="session-actions">
        <button onclick="renameSession('${id}')" title="${translations['rename_prompt'] || 'Rename'}">✏️</button>
        <button onclick="deleteSession('${id}')" title="${translations['delete_confirm'] || 'Delete'}">🗑️</button>
      </div>
    `;
    li.onclick = (e) => {
      if (e.target.tagName.toLowerCase() !== "button") {
        loadSession(id);
      }
    };
    sessionList.appendChild(li);
  });
}

function renderMessages(session) {
  chatBox.innerHTML = "";

  if (!session) {
    chatBox.innerHTML = `
      <div class="welcome-message" id="welcomeMessage">
        <span>${translations["welcome_message"] || "Welcome to your personal chat."}</span><br>
        <span>${translations["start_prompt"] || "Please create a new session below to begin."}</span>
      </div>`;
    setInputEnabled(false);
    return;
  }

  setInputEnabled(true);

  if (session.messages.length === 0) {
    chatBox.innerHTML = `
      <div class="welcome-message" id="welcomeMessage">
        <span>${translations["chat_ready"] || "Your personal chat is ready."}</span><br>
        <span>${translations["chat_start"] || "Start the conversation when you're ready."}</span>
      </div>`;
  }

  session.messages.forEach(msg => {
    if (!msg.text || msg.text.trim() === "") return;
    const div = document.createElement("div");
    div.className = `msg ${msg.sender}`;
    div.innerHTML = `<span>${msg.text}</span>`;
    chatBox.appendChild(div);
  });

  chatBox.scrollTop = chatBox.scrollHeight;
}

function loadSession(id) {
  currentSessionId = id;
  const session = sessionMode === "normal" ? sessions[id] : incognitoSessions[id];
  renderSessions();
  renderMessages(session);
  setInputEnabled(!!session);
  if (sessionMode === "normal") saveState();
}

// =================== Session CRUD ===================
function addNewSession() {
  const id = Date.now().toString();
  const session = { name: translations["new_session"] || "New Session", messages: [] };
  currentSessionId = id;

  if (sessionMode === "normal") {
    sessions[id] = session;
    saveState();
    persistToDB(id); // create immediately in backend
  } else {
    incognitoSessions[id] = session;
  }

  renderSessions();
  renderMessages(session);
  setInputEnabled(true);
}

function deleteSession(id) {
  if (!confirm(translations["delete_confirm"] || "Delete this session?")) return;

  if (sessionMode === "normal") {
    fetch("/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ session_id: id })
    }).catch(() => {});
    delete sessions[id];
  } else {
    delete incognitoSessions[id];
  }

  if (id === currentSessionId) currentSessionId = null;
  renderSessions();
  renderMessages(null);
  setInputEnabled(false);
  saveState();
}

function renameSession(id) {
  const name = prompt(translations["rename_prompt"] || "Enter new session name:");
  if (!name) return;

  if (sessionMode === "normal") {
    sessions[id].name = name;
    persistToDB(id);
    saveState();
  } else {
    incognitoSessions[id].name = name;
  }
  renderSessions();
}
window.renameSession = renameSession;
window.deleteSession = deleteSession;




// =================== Messaging ===================
function sendMessage() {
  const text = (messageInput.value || "").trim();
  if (!text || !currentSessionId) {
    messageInput.value = "";
    return;
  }

  const id = currentSessionId;
  const source = sessionMode === "normal" ? sessions : incognitoSessions;
  const session = source[id] || { name: "Session", messages: [] };

  // Push user message
  session.messages.push({ sender: "user", text });
  if (sessionMode === "normal") sessions[id] = session; else incognitoSessions[id] = session;

  renderMessages(session);
  messageInput.value = "";

  if (sessionMode === "normal") {
    saveState();
    persistToDB(id);
  }

  const selectedLanguage = localStorage.getItem("selectedLanguage") || "en";

  fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: id,
      session_id: id,
      message: text,
      language: selectedLanguage
    })
  })
    .then(res => res.json())
    .then(data => {
      const reply = data && data.reply ? data.reply : "…";
      session.messages.push({ sender: "therapist", text: reply });
      renderMessages(session);

      if (sessionMode === "normal") {
        sessions[id] = session;
        if (session.name === (translations["new_session"] || "New Session")) {
          autoRename(id, text, selectedLanguage);
        }
        saveState();
        persistToDB(id);
      } else {
        incognitoSessions[id] = session;
      }
    })
    .catch(err => console.error("Chat error:", err));
}

function autoRename(id, userPrompt, language) {
  fetch("/chat/rename_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: userPrompt, language })
  })
    .then(res => res.json())
    .then(data => {
      const newName = data && data.name ? data.name : "Session";
      if (sessions[id]) {
        sessions[id].name = newName;
        persistToDB(id);
        saveState();
        renderSessions();
      }
    })
    .catch(err => console.error("AutoRename error:", err));
}

// =================== Events ===================
sendBtn.onclick = sendMessage;
newSessionBtn.onclick = addNewSession;

messageInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

languageSelector.addEventListener("change", () => {
  const lang = languageSelector.value;
  loadTranslations(lang);

  // ✅ Also re-auto-rename sessions into new language
  Object.entries(sessions).forEach(([id, session]) => {
    if (session.messages.length > 0) {
      autoRename(id, session.messages[0].text, lang);
    }
  });
});

// =================== Boot ===================
window.onload = async () => {
  const savedLang = localStorage.getItem("selectedLanguage") || "en";
  if (languageSelector) languageSelector.value = savedLang;
  await loadTranslations(savedLang);

  sessionMode = modeSelector.value;
  incognitoBanner.style.display = sessionMode === "incognito" ? "block" : "none";

  renderSessions();
  if (sessionMode === "normal" && currentSessionId && sessions[currentSessionId]) {
    loadSession(currentSessionId);
  } else if (!currentSessionId) {
    renderMessages(null);
  }
};
