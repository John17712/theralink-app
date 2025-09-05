// ================= TRIAL CALL SETTINGS =================
const TRIAL_MAX_SESSIONS = 5;
const TRIAL_SESSION_LIMIT_MS = 5 * 60 * 1000; // 5 minutes per call

let trialSessionsUsed = parseInt(localStorage.getItem("trialSessionsUsed") || "0");
let trialActiveStart = null;
let timerInterval = null;

// ================= STATE =================
let callSessions = JSON.parse(localStorage.getItem("trialCallSessions")) || {};
let currentCallSessionId = localStorage.getItem("currentTrialCallSessionId") || null;

const sessionList = document.getElementById("callSessionList");
const transcriptBox = document.getElementById("transcriptBox");
const startCallBtn = document.getElementById("startCallBtn");
const endCallBtn = document.getElementById("endCallBtn");
const newCallSessionBtn = document.getElementById("newCallSessionBtn");
const therapistGenderSelect = document.getElementById("therapistGender");
const continueBtn = document.getElementById("continueBtn");
const callStatus = document.getElementById("callStatus");
const timeLeftEl = document.getElementById("timeLeft");
const sessionsLeftEl = document.getElementById("sessionsLeft");
const trialLimitBanner = document.getElementById("trialLimitBanner");

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

// Calls always in English for voice
const CALL_LANG_CODE = "en-US";

const preferredVoices = {
  "en-US": {
    female: ["Samantha", "Google US English", "Microsoft Aria Online (Natural) - English (United States)"],
    male: ["Alex", "David", "Daniel", "Google US English"]
  }
};

// ================= TRANSLATIONS =================
async function loadTranslations(lang) {
  try {
    const res = await fetch(`/static/lang/${lang}.json`);
    translations = await res.json();
    applyTranslations();
  } catch (e) {
    console.warn("Could not load language file:", lang, e);
  }
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
  continueBtn.innerText = translations["continue_btn"] || "Continue";

  if (therapistGenderSelect.options.length >= 2) {
    therapistGenderSelect.options[0].text = translations["voice_female"] || "Female";
    therapistGenderSelect.options[1].text = translations["voice_male"] || "Male";
  }

  if (trialLimitBanner.style.display === "block") {
    showTrialLimitBanner();
  }
}

// ================= TRIAL BANNER =================
function showTrialLimitBanner() {
  trialLimitBanner.style.display = "block";

  const msgEl = trialLimitBanner.querySelector("[data-i18n='trial_limit_reached']");
  const linkEl = trialLimitBanner.querySelector("[data-i18n='signup_now']");

  if (msgEl) msgEl.textContent = translations["trial_call_limit_reached"] || "⚠️ Your free trial call sessions are over. Please sign up to continue.";
  if (linkEl) linkEl.textContent = translations["signup_now"] || "Sign up now";

  if (newCallSessionBtn) newCallSessionBtn.disabled = true;
}

// ================= STATE SAVE/LOAD =================
function saveCallState() {
  localStorage.setItem("trialCallSessions", JSON.stringify(callSessions));
  localStorage.setItem("currentTrialCallSessionId", currentCallSessionId);
  localStorage.setItem("therapistVoice", voiceGender);
  localStorage.setItem("trialSessionsUsed", trialSessionsUsed);
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
  updateSessionsLeft();
}

function loadCallSession(id) {
  currentCallSessionId = id;
  titleGenerated = !!(callSessions[id] && callSessions[id]._titleGenerated);
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

// ================= TTS =================
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
    const base = langCode.split("-")[0];
    candidates = voices.filter(v => v.lang.toLowerCase().startsWith(base));
  }
  const prefs = (preferredVoices[langCode] && preferredVoices[langCode][gender]) || [];
  for (const name of prefs) {
    const hit = candidates.find(v => v.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return candidates[0] || voices[0] || null;
}

async function initVoices() {
  await ensureVoicesLoaded();
  selectedVoice = pickVoice(CALL_LANG_CODE, voiceGender);
}

function speakText(text) {
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = CALL_LANG_CODE;
  utter.voice = selectedVoice;
  utter.rate = 1;
  utter.pitch = 1;
  isTherapistSpeaking = true;
  utter.onend = () => {
    isTherapistSpeaking = false;
    startListening();
  };
  window.speechSynthesis.speak(utter);
}

// ================= TIMER =================
function updateTimerDisplay() {
  if (!trialActiveStart) return;
  const elapsed = Date.now() - trialActiveStart;
  let remaining = TRIAL_SESSION_LIMIT_MS - elapsed;
  if (remaining < 0) remaining = 0;

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  timeLeftEl.textContent = `${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;

  if (remaining === 0) {
    clearInterval(timerInterval);
    endCall();
    showTrialLimitBanner();
    alert(translations["call_session_expired"] || "⏰ Your trial call has ended. Please sign up to continue.");
    window.location.href = "/signup";
  }
}

function updateSessionsLeft() {
  const remaining = Math.max(0, TRIAL_MAX_SESSIONS - trialSessionsUsed);
  sessionsLeftEl.textContent = remaining;
  if (remaining === 0) showTrialLimitBanner();
}

// ================= CALL FLOW =================
function startCall() {
  if (!currentCallSessionId || !callSessions[currentCallSessionId]) return;

  trialActiveStart = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();

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
  clearInterval(timerInterval);
}

// ================= BACKEND REQUEST =================
function sendToTherapist(message) {
  if (!message) return;
  const session = callSessions[currentCallSessionId];
  if (message !== "__init__") {
    session.messages.push({ sender: "user", text: message });
  }
  renderTranscript(session);
  saveCallState();

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
    .then(r => r.json())
    .then(data => {
      if (data.reply) {
        session.messages.push({ sender: "therapist", text: data.reply });
        renderTranscript(session);
        speakText(data.reply);
        continueBtn.style.display = "none";

        if (!titleGenerated) autoRenameCallSession();
      } else if (data.error) {
        callStatus.innerText = data.error;
      }
    })
    .catch(err => {
      console.error("Call error:", err);
      callStatus.innerText = "Error: Unable to connect.";
    });
}

// ================= STT =================
function startListening() {
  if (!("webkitSpeechRecognition" in window) || isTherapistSpeaking) return;
  stopListening();

  recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = CALL_LANG_CODE;

  recognition.onstart = () => recognizing = true;
  recognition.onresult = e => {
    clearTimeout(silenceTimer);
    clearTimeout(longSilenceTimer);

    const result = Array.from(e.results).map(r => r[0].transcript).join(" ").trim();
    if (result) {
      fullTranscript = result;
      let live = transcriptBox.querySelector(".msg.user.speaking");
      if (!live) {
        const div = document.createElement("div");
        div.className = "msg user speaking";
        div.innerHTML = `<strong>${translations["you_speaking"] || "You"}:</strong> <span class="live-text">${result}</span>`;
        transcriptBox.appendChild(div);
      } else {
        live.querySelector(".live-text").innerText = result;
      }
      transcriptBox.scrollTop = transcriptBox.scrollHeight;

      silenceTimer = setTimeout(() => {
        recognition.stop();
        recognizing = false;
        sendToTherapist(result);
        fullTranscript = "";
      }, 4500);
    }

    longSilenceTimer = setTimeout(() => {
      if (!isTherapistSpeaking && !fullTranscript) {
        recognition.stop();
        continueBtn.style.display = "inline-block";
      }
    }, 10000);
  };
  recognition.onend = () => recognizing = false;
  recognition.start();
}

function stopListening() {
  if (recognition && recognizing) recognition.stop();
  recognizing = false;
  clearTimeout(silenceTimer);
  clearTimeout(longSilenceTimer);
}

// ================= SESSION MGMT =================
function addNewCallSession() {
  if (trialSessionsUsed >= TRIAL_MAX_SESSIONS) {
    showTrialLimitBanner();
    alert(translations["call_limit_reached"] || "Trial limit reached.");
    return;
  }
  const id = Date.now().toString();
  callSessions[id] = { name: translations["new_call_session"] || "New Call", messages: [], _titleGenerated: false };
  currentCallSessionId = id;
  trialSessionsUsed++;
  titleGenerated = false;
  saveCallState();
  renderCallSessions();
  loadCallSession(id);
  startCall();
}

function autoRenameCallSession() {
  const session = callSessions[currentCallSessionId];
  if (!session || !session.messages.length) return;

  fetch("/call/rename_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: session.messages.slice(-10), language: "en" })
  })
    .then(r => r.json())
    .then(data => {
      if (data.name) {
        session.name = data.name;
        session._titleGenerated = true;
        titleGenerated = true;
        renderCallSessions();
        saveCallState();
      }
    })
    .catch(err => console.error("Rename error:", err));
}

function renameCallSession(id) {
  const newName = prompt(translations["rename_prompt"] || "Enter new session name:");
  if (newName) {
    callSessions[id].name = newName;
    callSessions[id]._titleGenerated = true;
    renderCallSessions();
    saveCallState();
  }
}

function deleteCallSession(id) {
  if (confirm(translations["delete_confirm"] || "Delete this session?")) {
    delete callSessions[id];
    if (id === currentCallSessionId) currentCallSessionId = null;
    renderCallSessions();
    renderTranscript(null);
    updateButtonStates();
    saveCallState();
  }
}

function renderTranscript(session) {
  transcriptBox.innerHTML = "";
  if (!session || !session.messages.length) {
    transcriptBox.innerHTML = `<p class="transcript-placeholder">${translations["transcript_placeholder"] || "Transcript will appear here once the session begins."}</p>`;
    return;
  }
  session.messages.forEach(m => {
    if (m.text === "__init__") return;
    const div = document.createElement("div");
    div.className = `msg ${m.sender}`;
    const label = m.sender === "user" ? (translations["you"] || "You") : (translations["therapist"] || "Therapist");
    div.innerHTML = `<strong>${label}:</strong> ${m.text}`;
    transcriptBox.appendChild(div);
  });
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

// ================= INIT =================
therapistGenderSelect.value = "female";
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
  updateSessionsLeft();
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
