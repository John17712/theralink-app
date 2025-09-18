// ===== Local sessions =====
// { id: {id,name:{en:"..."},messages:[{sender,text}]} }
let chatSessions = JSON.parse(localStorage.getItem("chatSessions")) || {};
let currentChatSessionId = localStorage.getItem("currentChatSessionId") || null;

const sessionListEl   = document.getElementById("chatSessionList");
const newSessionBtn   = document.getElementById("newChatSessionBtn");
const transcriptBox   = document.getElementById("transcriptBox");
const chatStatus      = document.getElementById("chatStatus");
const messageInput    = document.getElementById("messageInput");
const sendBtn         = document.getElementById("sendBtn");
const languageSelector = document.getElementById("languageSelector");

let activeLang = localStorage.getItem("selectedLanguage") || "en";
let translations = {};

// ===== Utility =====
function saveState() {
  localStorage.setItem("chatSessions", JSON.stringify(chatSessions));
  localStorage.setItem("currentChatSessionId", currentChatSessionId || "");
}

function uid() {
  return "chat-" + Math.random().toString(36).slice(2, 9) + "-" + Date.now().toString(36);
}

// ===== Sidebar render =====
function renderSessions() {
  sessionListEl.innerHTML = "";
  const ids = Object.keys(chatSessions).sort((a, b) => {
    return (chatSessions[b]?.createdAt || 0) - (chatSessions[a]?.createdAt || 0);
  });

  ids.forEach((id) => {
    const s = chatSessions[id];
    if (s.name && typeof s.name === "string") {
      s.name = { en: s.name };
    }

    const li = document.createElement("li");
    li.className = id === currentChatSessionId ? "active" : "";
    li.onclick = () => activateSession(id);

    const title = document.createElement("div");
    title.className = "session-title";

    let displayName = "";
    if (s.name && typeof s.name === "object") {
      displayName =
        s.name[activeLang] ||
        s.name["en"] ||
        translations["session_default"] ||
        "Session";
    } else {
      displayName = translations["session_default"] || "Session";
    }
    title.textContent = displayName;

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const renameBtn = document.createElement("button");
    renameBtn.title = translations["rename_prompt"] || "Rename";
    renameBtn.textContent = "✏️";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      manualRenameSession(id);
    };

    const delBtn = document.createElement("button");
    delBtn.title = translations["delete_confirm"] || "Delete";
    delBtn.textContent = "🗑";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(id);
    };

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    li.appendChild(title);
    li.appendChild(actions);
    sessionListEl.appendChild(li);
  });
}

// ===== Manual Rename =====
function manualRenameSession(id) {
  const session = chatSessions[id];
  if (!session) return;

  const newName =
    prompt(translations["rename_prompt"] || "Enter new session name:") || "";
  if (!newName) return;

  if (!session.name || typeof session.name !== "object") {
    session.name = {};
  }
  session.name[activeLang] = newName;
  saveState();
  renderSessions();
}

// ===== Session lifecycle =====
function addNewSession() {
  const id = uid();
  chatSessions[id] = {
    id,
    name: { [activeLang]: translations["new_session"] || "New Session" },
    messages: [],
    createdAt: Date.now(),
  };
  currentChatSessionId = id;
  saveState();
  renderSessions();
  renderTranscript();
  setStatus(translations["session_created"] || "Session created. You can start chatting.");
}

function deleteSession(id) {
  if (!chatSessions[id]) return;
  const wasActive = id === currentChatSessionId;
  delete chatSessions[id];

  if (wasActive) {
    currentChatSessionId = null;
    renderTranscript();
    setStatus(translations["create_session_prompt"] || "Please create a new session to begin.");
  }

  saveState();
  renderSessions();
}

function activateSession(id) {
  currentChatSessionId = id;
  saveState();
  renderSessions();
  renderTranscript();
  setStatus("");
}

// ===== Transcript render =====
function setStatus(text) {
  chatStatus.textContent = text || "";
  chatStatus.style.display = text ? "block" : "none";
}

function renderTranscript() {
  transcriptBox.innerHTML = "";

  if (!currentChatSessionId || !chatSessions[currentChatSessionId]) {
    const p = document.createElement("p");
    p.className = "transcript-placeholder";
    p.textContent =
      translations["chat_transcript_placeholder"] ||
      "Messages will appear here once the session begins.";
    transcriptBox.appendChild(p);
    return;
  }

  const msgs = chatSessions[currentChatSessionId].messages || [];
  if (msgs.length === 0) {
    const p = document.createElement("p");
    p.className = "transcript-placeholder";
    p.textContent =
      translations["chat_start_placeholder"] ||
      "Welcome — start your conversation when you’re ready.";
    transcriptBox.appendChild(p);
  } else {
    msgs.forEach((m) => {
      const div = document.createElement("div");
      div.className = `msg ${m.sender}`;
      const label =
        m.sender === "user"
          ? translations["you_label"] || "You"
          : translations["therapist_label"] || "Therapist";
      div.innerHTML = `<strong>${label}:</strong> ${m.text}`;
      transcriptBox.appendChild(div);
    });
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }
}

// ===== Messaging =====
async function sendMessage() {
  const text = (messageInput.value || "").trim();
  if (!text) return;

  if (!currentChatSessionId || !chatSessions[currentChatSessionId]) {
    setStatus(translations["create_session_prompt"] || "Please create a new session first.");
    return;
  }

  chatSessions[currentChatSessionId].messages.push({ sender: "user", text });
  messageInput.value = "";
  renderTranscript();
  saveState();

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "full_user",
        session_id: currentChatSessionId,
        message: text,
        language: activeLang,
      }),
    });

    const data = await res.json();
    const replyText = data.reply || "Sorry, something went wrong.";

    chatSessions[currentChatSessionId].messages.push({
      sender: "therapist",
      text: replyText,
    });
    renderTranscript();
    saveState();

    // Auto-rename
    const session = chatSessions[currentChatSessionId];
    let currentName =
      session.name && typeof session.name === "object"
        ? session.name[activeLang]
        : session.name;
    const needsName =
      !currentName ||
      currentName === (translations["new_session"] || "New Session");
    if (needsName && text) {
      autoRenameCurrentSession(text);
    }
  } catch (err) {
    console.error("Chat error:", err);
    setStatus("Sorry, something went wrong.");
  }
}

// ===== Auto-rename =====
async function autoRenameCurrentSession(sampleText) {
  try {
    const res = await fetch("/chat/rename_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: sampleText || "Therapy session",
        language: activeLang,
      }),
    });
    const data = await res.json();
    const newName =
      (data && data.name) || translations["session_default"] || "Session";
    if (currentChatSessionId && chatSessions[currentChatSessionId]) {
      if (
        !chatSessions[currentChatSessionId].name ||
        typeof chatSessions[currentChatSessionId].name !== "object"
      ) {
        chatSessions[currentChatSessionId].name = {};
      }
      chatSessions[currentChatSessionId].name[activeLang] = newName;
      saveState();
      renderSessions();
    }
  } catch (e) {
    console.error("Rename error:", e);
  }
}

// ===== Language =====
async function loadTranslations(lang) {
  try {
    const res = await fetch(`/static/lang/${lang}.json`);
    if (!res.ok) throw new Error("Could not load translations");
    const dict = await res.json();

    translations = dict;
    localStorage.setItem("selectedLanguage", lang);
    activeLang = lang;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[key]) {
        if (["input", "textarea"].includes(el.tagName.toLowerCase())) {
          el.placeholder = dict[key];
        } else {
          el.textContent = dict[key];
        }
      }
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (dict[key]) el.setAttribute("placeholder", dict[key]);
    });

    document.body.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");

    renderSessions();
    renderTranscript();
  } catch (err) {
    console.error("Error loading language:", err);
  }
}

// ===== Events =====
newSessionBtn.addEventListener("click", addNewSession);
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
languageSelector.addEventListener("change", (e) => {
  loadTranslations(e.target.value);
});

// ===== Init =====
(function init() {
  renderSessions();
  renderTranscript();
  const savedLang = localStorage.getItem("selectedLanguage") || "en";
  loadTranslations(savedLang);
})();

