let userId = "test_user";
let sessionId = null;
let sessions = JSON.parse(localStorage.getItem("sessions")) || {};

const chatBox = document.getElementById("chatBox");
const sessionList = document.getElementById("sessionList");
const messageInput = document.getElementById("messageInput");

function saveSessions() {
    localStorage.setItem("sessions", JSON.stringify(sessions));
}

function renderSessionList() {
    sessionList.innerHTML = "";
    Object.keys(sessions).forEach(id => {
        const li = document.createElement("li");
        li.textContent = sessions[id].name || "Unnamed Session";
        li.classList.add("session-item");
        li.onclick = () => loadSession(id);
        sessionList.appendChild(li);
    });
}

function loadSession(id) {
    sessionId = id;
    chatBox.innerHTML = "";
    sessions[sessionId].messages.forEach(msg => {
        appendMessage(msg.sender, msg.text);
    });
}

function appendMessage(sender, text) {
    const div = document.createElement("div");
    div.classList.add("message", sender);
    div.innerHTML = `<strong>${sender === "user" ? "You" : "Therapist"}:</strong> ${text}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    appendMessage("user", message);
    sessions[sessionId].messages.push({ sender: "user", text: message });
    saveSessions();
    messageInput.value = "";

    fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, session_id: sessionId, message })
    })
    .then(res => res.json())
    .then(data => {
        const reply = data.response || "Sorry, something went wrong.";
        appendMessage("therapist", reply);
        sessions[sessionId].messages.push({ sender: "therapist", text: reply });
        if (!sessions[sessionId].name || sessions[sessionId].name === "Unnamed Session") {
            sessions[sessionId].name = data.topic || "Therapy Session";
        }
        saveSessions();
        renderSessionList();
    })
    .catch(() => {
        appendMessage("therapist", "Sorry, something went wrong.");
    });
}

function newSession() {
    const id = "session_" + new Date().getTime();
    sessions[id] = { name: "Unnamed Session", messages: [] };
    sessionId = id;
    saveSessions();
    renderSessionList();
    loadSession(id);
}

document.getElementById("sendBtn").addEventListener("click", sendMessage);
document.getElementById("newSessionBtn").addEventListener("click", newSession);

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Initialize on load
if (Object.keys(sessions).length === 0) {
    newSession();
} else {
    renderSessionList();
    sessionId = Object.keys(sessions)[0];
    loadSession(sessionId);
}
