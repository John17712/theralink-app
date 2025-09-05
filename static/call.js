let callSessions = JSON.parse(localStorage.getItem("callSessions")) || {};
let currentCallSessionId = localStorage.getItem("currentCallSessionId") || null;

const sessionList = document.getElementById("callSessionList");
const transcriptBox = document.getElementById("transcriptBox");
const startCallBtn = document.getElementById("startCallBtn");
const endCallBtn = document.getElementById("endCallBtn");
const newCallSessionBtn = document.getElementById("newCallSessionBtn");
const therapistGenderSelect = document.getElementById("therapistGender");
const continueBtn = document.getElementById("continueBtn");
const callStatus = document.getElementById("callStatus");

let recognizing = false;
let recognition;
let selectedVoice = null;
let voiceGender = localStorage.getItem("therapistVoice") || "female";
let silenceTimer = null;
let longSilenceTimer = null;
let isTherapistSpeaking = false;
let fullTranscript = "";
let titleGenerated = false;
let translations = {};
let ttsWarnedOnce = false;

// 🔹 Calls always in English for speech + model
const CALL_LANG_CODE = "en-US";

// Preferred voices for English
const preferredVoices = {
  "en-US": {
    female: ["Samantha", "Google US English", "Microsoft Aria Online (Natural) - English (United States)"],
    male: ["Alex", "David", "Daniel", "Google US English"]
  }
};

// ---------------- 🌍 Load UI Translations ----------------
async function loadTranslations(lang) {
  try {
    const res = await fetch(`/static/lang/${lang}.json`);
    translations = await res.json();
    applyTranslations();
  } catch (e) {
    console.warn("Could not load language file:", lang, e);
  }
}

// --- save to DB
function persistCallToDB(id) {
  try {
    const s = callSessions[id];
    if (!s) return;
    fetch("/sessions/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        session_id: id,
        name: s.name || "Session",
        messages: s.messages || [],
        kind: "call"
      })
    }).catch(() => {});
  } catch (_) {}
}

function applyTranslations() {
  callStatus.innerText = !currentCallSessionId
    ? (translations["call_status_placeholder"] || "Please create a new session to begin.")
    : (translations["call_not_started"] || "Call not started.");

  const placeholder = transcriptBox.querySelector(".transcript-placeholder");
  if (placeholder) {
    placeholder.innerText = translations["transcript_placeholder"] || "Transcript will appear here once the session begins.";
  }

  startCallBtn.innerText = translations["start_call"] || "Start Call";
  endCallBtn.innerText = translations["end_call"] || "End Call";
  newCallSessionBtn.innerText = translations["new_call_session"] || "New Session";
  continueBtn.innerText = translations["continue"] || "Continue";
  if (therapistGenderSelect && therapistGenderSelect.options.length >= 2) {
    therapistGenderSelect.options[0].text = translations["female"] || "Female";
    therapistGenderSelect.options[1].text = translations["male"] || "Male";
  }
}

// ---------------- 💾 State ----------------
function saveCallState() {
  localStorage.setItem("callSessions", JSON.stringify(callSessions));
  localStorage.setItem("currentCallSessionId", currentCallSessionId);
  localStorage.setItem("therapistVoice", voiceGender);
}

function renderCallSessions() {
  sessionList.innerHTML = "";
  Object.entries(callSessions).forEach(([id, session]) => {
    const li = document.createElement("li");
    li.className = currentCallSessionId === id ? "active" : "";
    li.innerHTML = `
      <span class="session-title">${session.name || "Call Session"}</span>
      <div class="session-actions">
        <button onclick="renameCallSession('${id}')">✏️</button>
        <button onclick="deleteCallSession('${id}')">🗑️</button>
      </div>
    `;
    li.onclick = () => loadCallSession(id);
    sessionList.appendChild(li);
  });
}

function loadCallSession(id) {
  currentCallSessionId = id;
  renderTranscript(callSessions[id]);
  updateButtonStates();
  saveCallState();
  applyTranslations();
}

function updateButtonStates() {
  const disabled = !currentCallSessionId || !callSessions[currentCallSessionId];
  startCallBtn.disabled = disabled;
  endCallBtn.disabled = true;

  callStatus.innerText = disabled
    ? (translations["call_status_placeholder"] || "Please create a new session to begin.")
    : (translations["call_not_started"] || "Call not started.");

  if (disabled) {
    transcriptBox.innerHTML = `<p class="transcript-placeholder">${translations["transcript_placeholder"] || "Transcript will appear here once the session begins."}</p>`;
  }
}

// ---------------- 🎙️ TTS ----------------
function ensureVoicesLoaded(timeoutMs = 1500) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const tick = () => {
      const voices = speechSynthesis.getVoices();
      if (voices.length) return resolve(voices);
      if (performance.now() - t0 > timeoutMs) return resolve([]);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function pickVoice(langCode, gender) {
  const voices = speechSynthesis.getVoices();
  let candidates = voices.filter(v => v.lang.toLowerCase() === langCode.toLowerCase());

  if (!candidates.length) {
    const base2 = langCode.split("-")[0];
    candidates = voices.filter(v => v.lang.toLowerCase().startsWith(base2));
  }

  const prefs = (preferredVoices[langCode] && preferredVoices[langCode][gender]) || [];
  for (const name of prefs) {
    const hit = candidates.find(v => v.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }

  const genderRegex = gender === "female"
    ? /(female|aria|samantha|zira|eva)/i
    : /(male|david|daniel|alex)/i;

  return candidates.find(v => genderRegex.test(v.name)) || candidates[0] || voices[0] || null;
}

async function initVoices() {
  await ensureVoicesLoaded();
  selectedVoice = pickVoice(CALL_LANG_CODE, voiceGender);
  if (!selectedVoice && !ttsWarnedOnce) {
    console.warn("No matching English voice found — using default system voice.");
    ttsWarnedOnce = true;
  }
}

function speakText(text) {
  const synth = window.speechSynthesis;
  synth.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = CALL_LANG_CODE;
  utter.voice = selectedVoice;
  utter.rate = 1;
  utter.pitch = 1.0;

  isTherapistSpeaking = true;
  utter.onend = () => {
    isTherapistSpeaking = false;
    startListening();
  };

  synth.speak(utter);
}

// ---------------- 📞 Call flow ----------------
function startCall() {
  if (!currentCallSessionId || !callSessions[currentCallSessionId]) return;
  callStatus.innerText = translations["call_in_progress"] || "Call in progress...";
  startCallBtn.disabled = true;
  endCallBtn.disabled = false;
  continueBtn.style.display = "none";

  const session = callSessions[currentCallSessionId];
  if (session.messages.length === 0) {
    sendToTherapist("__init__");
  } else {
    startListening();
  }
}

function endCall() {
  callStatus.innerText = translations["call_ended"] || "Call ended.";
  startCallBtn.disabled = false;
  endCallBtn.disabled = true;
  stopListening();
  window.speechSynthesis.cancel();
}

function sendToTherapist(message) {
  if (!message) return;
  const session = callSessions[currentCallSessionId];

  if (message !== "__init__") {
    session.messages.push({ sender: "user", text: message });
  }

  renderTranscript(session);
  saveCallState();
  persistCallToDB(currentCallSessionId);

  fetch("/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: currentCallSessionId,
      session_id: currentCallSessionId,
      message: message,
      gender: voiceGender
    })
  })
    .then(res => res.json())
    .then(data => {
      if (data.reply) {
        session.messages.push({ sender: "therapist", text: data.reply });
        renderTranscript(session);
        continueBtn.style.display = "none";
        speakText(data.reply);
        if (!titleGenerated && message !== "__init__") {
          autoRenameCallSession();
        }
      } else if (data.error) {
        callStatus.innerText = data.error;
      }
    })
    .catch(err => {
      console.error("Error in call request:", err);
      callStatus.innerText = "Error: Unable to connect to call.";
    });
}

function autoRenameCallSession() {
  const session = callSessions[currentCallSessionId];
  const messages = session.messages.slice(-6);

  fetch("/call/rename_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, language: "en" })
  })
    .then(res => res.json())
    .then(data => {
      if (data.name) {
        callSessions[currentCallSessionId].name = data.name;
        titleGenerated = true;
        renderCallSessions();
        saveCallState();
        persistCallToDB(currentCallSessionId);
      }
    });
}

// ---------------- 🎧 STT ----------------
function startListening() {
  if (!("webkitSpeechRecognition" in window) || isTherapistSpeaking) return;
  stopListening();

  recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = CALL_LANG_CODE;
  fullTranscript = "";

  recognition.onstart = () => recognizing = true;

  recognition.onresult = (event) => {
    if (isTherapistSpeaking) return;

    clearTimeout(silenceTimer);
    clearTimeout(longSilenceTimer);

    const result = Array.from(event.results).map(r => r[0].transcript).join(" ").trim();

    if (result.length > 0) {
      fullTranscript = result;

      let live = transcriptBox.querySelector(".msg.user.speaking");
      if (!live) {
        const div = document.createElement("div");
        div.className = "msg user speaking";
        div.innerHTML = `<strong>${translations["you_speaking"] || "You (speaking)"}:</strong> <span class="live-text">${fullTranscript}</span>`;
        transcriptBox.appendChild(div);
      } else {
        live.querySelector(".live-text").innerText = fullTranscript;
      }

      transcriptBox.scrollTop = transcriptBox.scrollHeight;

      silenceTimer = setTimeout(() => {
        recognition.stop();
        recognizing = false;
        sendToTherapist(fullTranscript);
        fullTranscript = "";
      }, 4500);
    }

    longSilenceTimer = setTimeout(() => {
      if (!isTherapistSpeaking && fullTranscript === "") {
        recognition.stop();
        continueBtn.style.display = "inline-block";
      }
    }, 10000);
  };

  recognition.onerror = (e) => console.error("Recognition error:", e.error);
  recognition.onend = () => recognizing = false;
  recognition.start();
}

function stopListening() {
  if (recognition && recognizing) {
    recognition.stop();
    recognizing = false;
  }
  clearTimeout(silenceTimer);
  clearTimeout(longSilenceTimer);
}

// ---------------- Sessions ----------------
function addNewCallSession() {
  const id = Date.now().toString();
  callSessions[id] = {
    name: translations["new_call_session"] || "New Call Session",
    messages: []
  };
  currentCallSessionId = id;
  persistCallToDB(id);
  titleGenerated = false;
  renderCallSessions();
  loadCallSession(id);
  startCall();
}

function renameCallSession(id) {
  const newName = prompt(translations["rename_prompt"] || "Enter new session name:");
  if (newName) {
    callSessions[id].name = newName;
    renderCallSessions();
    saveCallState();
  }
}

function deleteCallSession(id) {
  if (confirm(translations["delete_confirm"] || "Delete this session?")) {
    // Remove from memory
    delete callSessions[id];

    // If the deleted one was active, clear the main page too
    if (id === currentCallSessionId) {
      currentCallSessionId = null;
      transcriptBox.innerHTML = `<p class="transcript-placeholder">${
        translations["transcript_placeholder"] || "Transcript will appear here once the session begins."
      }</p>`;
      callStatus.innerText = translations["call_status_placeholder"] || "Please create a new session to begin.";
      startCallBtn.disabled = true;
      endCallBtn.disabled = true;
    }

    renderCallSessions();
    updateButtonStates();
    saveCallState();
  }
}

function renderTranscript(session) {
  transcriptBox.innerHTML = "";
  if (!session || session.messages.length === 0) {
    transcriptBox.innerHTML = `<p class="transcript-placeholder">${translations["transcript_placeholder"] || "Transcript will appear here once the session begins."}</p>`;
    return;
  }

  session.messages.forEach(msg => {
    if (msg.text === "__init__") return;
    const msgDiv = document.createElement("div");
    msgDiv.className = `msg ${msg.sender}`;
    const label = msg.sender === "user"
      ? (translations["you"] || "You")
      : (translations["therapist"] || "Therapist");
    msgDiv.innerHTML = `<strong>${label}:</strong> ${msg.text}`;
    transcriptBox.appendChild(msgDiv);
  });

  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

// ---------------- Init ----------------
therapistGenderSelect.value = voiceGender;
therapistGenderSelect.onchange = async () => {
  voiceGender = therapistGenderSelect.value;
  await initVoices();
  saveCallState();
};

window.onload = async () => {
  await loadTranslations(localStorage.getItem("selectedLanguage") || "en");
  speechSynthesis.onvoiceschanged = initVoices;
  await initVoices();
  renderCallSessions();
  if (currentCallSessionId && callSessions[currentCallSessionId]) {
    loadCallSession(currentCallSessionId);
  } else {
    renderTranscript(null);
    updateButtonStates();
  }
};

startCallBtn.onclick = startCall;
endCallBtn.onclick = endCall;
newCallSessionBtn.onclick = addNewCallSession;
continueBtn.onclick = () => {
  continueBtn.style.display = "none";
  startListening();
};

(function useSidFromDashboard(){
  const sid = localStorage.getItem('openDbCallSid');
  if (!sid) return;
  localStorage.removeItem('openDbCallSid');

  if (typeof window.selectCallSessionById === 'function') {
    window.selectCallSessionById(sid);
  } else {
    window.currentCallSessionId = sid;
  }
})();
