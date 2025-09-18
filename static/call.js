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
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);


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


function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
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
  if (!selectedVoice) {
    console.warn("No matching voice found, using default.");
    const voices = speechSynthesis.getVoices();
    selectedVoice = voices[0] || null; // fallback voice
  }
}



function playTurnSound() {
  console.log("🔔 playTurnSound() called!");
  const audio = new Audio("/static/sounds/turn.mp3");
  audio.play().catch(err => console.warn("❌ Ding blocked:", err));
}


function showUserTurn() {
  callStatus.innerText = "Your turn to speak...";
  callStatus.style.color = "limegreen";
}

function hideUserTurn() {
  callStatus.innerText = translations["call_in_progress"] || "Call in progress...";
  callStatus.style.color = "";
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
  hideUserTurn();

utter.onend = () => {
  console.log("✅ Therapist finished. Therapist turn ended.");
  isTherapistSpeaking = false;

  setTimeout(() => {
    // 🔔 Play turn sound + update UI
    playTurnSound();
    showUserTurn();

    // 📱 iOS → use MediaRecorder fallback
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      onTherapistFinished();   // auto-start mic for iOS
    } 
    // 💻 Desktop (Mac/Windows) → use webkitSpeechRecognition
    else {
      startListening();
    }
  }, 200); // small delay avoids conflicts with speechSynthesis.cancel
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

function startListening() {
  // ✅ iOS Safari fallback — use manual mic button
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    console.warn("iOS Safari detected — falling back to manual mic mode.");
    callStatus.innerText = "🎤 Tap the mic button below to speak.";
    return;
  }

  // ✅ Check browser support
  if (!("webkitSpeechRecognition" in window)) {
    console.warn("Speech recognition not supported in this browser.");
    callStatus.innerText = "⚠️ Speech recognition not supported. Please use Chrome or Edge.";
    return;
  }

  // ✅ Prevent overlap while therapist is talking
  if (isTherapistSpeaking) return;

  // Reset previous recognition if running
  stopListening();

  // Initialize recognition
  recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = CALL_LANG_CODE;
  fullTranscript = "";

  recognition.onstart = () => {
    recognizing = true;
    console.log("🎤 Listening started...");
  };

  recognition.onresult = (event) => {
    if (isTherapistSpeaking) return;

    // Reset silence timers on every new word
    clearTimeout(silenceTimer);
    clearTimeout(longSilenceTimer);

    const result = Array.from(event.results)
      .map(r => r[0].transcript)
      .join(" ")
      .trim();

    if (result.length > 0) {
      fullTranscript = result;

      // ✅ Show live transcript
      let live = transcriptBox.querySelector(".msg.user.speaking");
      if (!live) {
        const div = document.createElement("div");
        div.className = "msg user speaking";
        div.innerHTML = `<strong>${translations["you_speaking"] || "You (speaking)"}:</strong> 
                         <span class="live-text">${fullTranscript}</span>`;
        transcriptBox.appendChild(div);
      } else {
        live.querySelector(".live-text").innerText = fullTranscript;
      }

      transcriptBox.scrollTop = transcriptBox.scrollHeight;

      // ✅ Short pause (~4.5s) → finalize and send to therapist
      silenceTimer = setTimeout(() => {
        recognition.stop();
        recognizing = false;
        sendToTherapist(fullTranscript);
        fullTranscript = "";
      }, 4500);
    }

    // ✅ Long silence (~10s) → stop listening, show Continue button
    longSilenceTimer = setTimeout(() => {
      if (!isTherapistSpeaking && fullTranscript === "") {
        recognition.stop();
        showUserTurn();
        playTurnSound();
        continueBtn.style.display = "inline-block";
      }
    }, 10000);
  };

  recognition.onerror = (e) => {
    console.error("Recognition error:", e.error);
    callStatus.innerText = "⚠️ Speech recognition error. Try again.";
  };

  recognition.onend = () => {
    recognizing = false;
    console.log("🎤 Listening ended.");
  };

  recognition.start();
}

function stopListening() {
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      console.warn("Tried to stop recognition that wasn’t running.");
    }
  }
  recognizing = false;
  clearTimeout(silenceTimer);
  clearTimeout(longSilenceTimer);
}


// ---------------- Sessions ----------------
function addNewCallSession() {
  const id = Date.now().toString();
  callSessions[id] = {
    name: translations["new_call_session"] || "New Call Session",
    messages: [],
    kind: "call"   // 👈 make sure it’s marked as a call session
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

async function deleteCallSession(id) {
  if (!confirm(translations["delete_confirm"] || "Delete this session?")) return;

  // 🔹 Remove from memory
  delete callSessions[id];

  // 🔹 If active, reset UI
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

  // 🔹 Delete globally in DB
  try {
    await fetch("/sessions/delete", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id })
    });

    // 🔹 Notify dashboard if open
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: "refreshSessions" }, "*");
      } catch (_) {
        console.warn("Could not notify dashboard to refresh sessions");
      }
    }

  } catch (err) {
    console.error("Failed to delete from DB:", err);
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

  // 🔹 Fetch DB sessions before rendering
  try {
  const res = await fetch("/sessions/call", { credentials: "include" });
  const data = await res.json();
  if (data.success) {
    data.sessions.forEach(s => {
      callSessions[s.session_id] = s;
    });
    saveCallState();
  }
} catch (err) {
  console.error("Error fetching call sessions from DB:", err);
}


  renderCallSessions();

  // ✅ If dashboard passed a sid, open that session (even if it came from DB)
  const sid = getQueryParam("sid");
  if (sid && callSessions[sid]) {
    loadCallSession(sid);
  } else if (currentCallSessionId && callSessions[currentCallSessionId]) {
    loadCallSession(currentCallSessionId);
  } else {
    renderTranscript(null);
    updateButtonStates();
  }
};



startCallBtn.onclick = startCall;

// 🔓 Mobile audio/mic unlock on first tap
startCallBtn.addEventListener("click", () => {
  // Unlock audio
  try {
    const unlockUtter = new SpeechSynthesisUtterance(" ");
    speechSynthesis.speak(unlockUtter);
  } catch (e) {
    console.warn("Audio unlock failed:", e);
  }

  // Unlock mic (Android only, iOS Safari doesn’t support webkitSpeechRecognition)
  if ("webkitSpeechRecognition" in window && !/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      let dummy = new webkitSpeechRecognition();
      dummy.start();
      setTimeout(() => dummy.stop(), 50);
    } catch (e) {
      console.warn("Mic unlock failed:", e);
    }
  }
});


startCallBtn.addEventListener("click", () => {
  // Preload ding sound to avoid autoplay block
  const audio = new Audio("/static/sounds/turn.mp3");
  audio.play().then(() => audio.pause()).catch(() => {});
});

endCallBtn.onclick = endCall;
newCallSessionBtn.onclick = addNewCallSession;

continueBtn.onclick = () => {
  continueBtn.style.display = "none";
  hideUserTurn();
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

// ---------------- 🎤 Mic Button (iOS + Desktop) ----------------
const micBtn = document.getElementById("micBtn");
let mediaRecorder, audioChunks = [];
let isRecording = false;


// 🔴 Blink effect when auto-listening
function setMicBlinking(active) {
  if (active) {
    micBtn.classList.add("blinking");
  } else {
    micBtn.classList.remove("blinking");
  }
}

// ✅ Start recording (manual or auto)
async function startRecording(auto = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Safari needs mp4, Chrome/Edge use webm
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const mimeType = isSafari ? "audio/mp4" : "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      setMicBlinking(false);
      clearTimeout(silenceTimer);

      // Small delay so Safari flushes last chunk
      setTimeout(async () => {
        const ext = isSafari ? "mp4" : "webm";
        const blob = new Blob(audioChunks, { type: `audio/${ext}` });

        // ✅ Add debug log here
        console.log("📱 iOS sending blob:", blob.size, blob.type);

        // ❌ Skip empty/too small blobs
       // ✅ Only reject if truly empty
          if (blob.size === 0) {
            callStatus.innerText = "⚠️ Empty audio, try again.";
            return;
          }
          console.log("📦 Uploading blob size:", blob.size, "type:", blob.type);


        const formData = new FormData();
        formData.append("audio", blob, `voice.${ext}`);

        try {
          const res = await fetch("/transcribe", { method: "POST", body: formData });
          const data = await res.json();

          if (data.text) {
            // Show transcript
            const div = document.createElement("div");
            div.className = "msg user";
            div.innerHTML = `<strong>${translations["you"] || "You"}:</strong> ${data.text}`;
            transcriptBox.appendChild(div);
            transcriptBox.scrollTop = transcriptBox.scrollHeight;

            // Send to therapist
            sendToTherapist(data.text);
            callStatus.innerText = "✅ Sent to therapist";
          } else {
            callStatus.innerText = "⚠️ Could not transcribe audio.";
          }
        } catch (err) {
          console.error("Transcription error:", err);
          callStatus.innerText = "⚠️ Failed to process audio.";
        }
      }, 250);
    };

    mediaRecorder.start();
    isRecording = true;

    if (auto) {
      setMicBlinking(true);
      callStatus.innerText = "🎙️ Listening...";
      resetSilenceTimer();
    } else {
      callStatus.innerText = "🎙️ Recording... Tap again to stop.";
      micBtn.textContent = "⏹ Stop Talking";
    }

  } catch (err) {
    console.error("Mic error:", err);
    callStatus.innerText = "⚠️ Microphone access denied.";
  }
}

// ✅ Stop recording
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.textContent = "🎤 Start Talking";
    callStatus.innerText = "⏳ Processing...";
  }
}

// ✅ Silence detection (auto stop after 6s pause)
function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    console.log("⏹ Auto stop: silence detected");
    stopRecording();
  }, 6000);
}

// ✅ Manual toggle (still works for desktop)
micBtn.onclick = () => {
  if (!isRecording) {
    startRecording(false);
  } else {
    stopRecording();
  }
};

// ✅ Hook: Therapist finished → auto start mic
function onTherapistFinished() {
  if (!isRecording) {
    startRecording(true); // auto mode
  }
}


// ---------------- 🎤 iOS Live Recording (Improved) ----------------
let liveStream, liveRecorder;
let liveTranscriptDiv;
let liveTextBuffer = "";

// ✅ Start live transcription on iOS
async function startIOSLiveTranscription() {
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    liveRecorder = new MediaRecorder(liveStream, { mimeType: "audio/mp4" });

    // Create a "speaking" bubble if not already there
    liveTranscriptDiv = document.querySelector(".msg.user.speaking");
    if (!liveTranscriptDiv) {
      liveTranscriptDiv = document.createElement("div");
      liveTranscriptDiv.className = "msg user speaking";
      liveTranscriptDiv.innerHTML =
        `<strong>${translations["you_speaking"] || "You (speaking)"}:</strong> <span class="live-text"></span>`;
      transcriptBox.appendChild(liveTranscriptDiv);
    }

    liveTextBuffer = "";

    liveRecorder.ondataavailable = async (e) => {
  console.log("🎤 iOS chunk size:", e.data.size);

  // ✅ Only skip if truly empty
  if (e.data.size === 0) {
    console.warn("⚠️ Empty chunk skipped");
    return;
  }

  const formData = new FormData();
  formData.append("audio", e.data, "chunk.mp4");

  try {
    const res = await fetch("/transcribe", { method: "POST", body: formData });
    const data = await res.json();
    console.log("📜 iOS partial transcript:", data);

    if (data.text && data.text.trim() !== "") {
      liveTextBuffer += " " + data.text;
      liveTranscriptDiv.querySelector(".live-text").innerText = liveTextBuffer.trim();
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
      resetSilenceTimer();
    } else {
      console.warn("⚠️ iOS chunk had no text");
    }
  } catch (err) {
    console.warn("⚠️ iOS chunk transcription failed:", err);
  }
};


    liveRecorder.start(); // no interval
    // Force flush every 800ms manually
    liveTranscribeTimer = setInterval(() => {
      if (liveRecorder && liveRecorder.state === "recording") {
        liveRecorder.requestData();
      }
    }, 800);

    callStatus.innerText = "🎙️ Listening... (iOS live)";
    setMicBlinking(true);
    resetSilenceTimer();

  } catch (err) {
    console.error("❌ iOS live mic error:", err);
    callStatus.innerText = "⚠️ iOS microphone error.";
  }
}

// ✅ Stop transcription and finalize
function stopIOSLiveTranscription() {
  if (liveRecorder && liveRecorder.state === "recording") {
    clearInterval(liveTranscribeTimer);
    liveRecorder.stop();
    liveStream.getTracks().forEach(t => t.stop());
  }
  setMicBlinking(false);

  if (liveTranscriptDiv) {
    liveTranscriptDiv.classList.remove("speaking");

    // Switch label to "You"
    const label = liveTranscriptDiv.querySelector("strong");
    if (label) label.innerText = `${translations["you"] || "You"}:`;

    // Send final text
    const finalText = liveTranscriptDiv.querySelector(".live-text").innerText.trim();
    if (finalText) sendToTherapist(finalText);

    liveTranscriptDiv = null;
  }

  callStatus.innerText = "⏳ Processing...";
}
