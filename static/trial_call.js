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


// ================= TTS FUNCTIONS =================
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

// ================= PLAY TURN SOUND (iOS compatible) =================
function playTurnSound() {
  try {
    const audio = new Audio("/static/sounds/turn.mp3");
    audio.volume = 0.3; // Lower volume for iOS
    audio.play().catch(e => {
      console.warn("Turn sound blocked:", e);
      // Fallback: use vibration if available
      if (navigator.vibrate) {
        navigator.vibrate(200);
      }
    });
  } catch (e) {
    console.warn("Could not play turn sound:", e);
  }
}

function showUserTurn() {
  callStatus.innerText = translations["your_turn"] || "🗣️ Your turn to speak...";
  callStatus.style.color = "limegreen";
}

function hideUserTurn() {
  callStatus.innerText = translations["therapist_speaking"] || "🎤 Therapist is speaking...";
  callStatus.style.color = "";
}

function stopListening() {
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      console.warn("Tried to stop recognition that wasn't running.");
    }
  }
  recognizing = false;
  clearTimeout(silenceTimer);
  clearTimeout(longSilenceTimer);
}

// ================= TTS SPEAKING =================
// ================= UPDATED SPEAK TEXT =================
function speakText(text) {
  console.log("🔊 Speaking:", text);
  
  unlockAudioOnIOS();
  const synth = window.speechSynthesis;
  synth.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = CALL_LANG_CODE;
  utter.voice = selectedVoice;
  utter.rate = 1;
  utter.pitch = 1.0;

  isTherapistSpeaking = true;
  callStatus.innerText = "Therapist is speaking...";
  callStatus.style.color = "";

  utter.onend = () => {
    console.log("✅ Therapist finished speaking");
    isTherapistSpeaking = false;
    
    setTimeout(() => {
      playTurnSound();
      // Show mic button for user to respond
      micBtn.style.display = 'inline-block';
      micBtn.textContent = '🎤 Tap to Speak';
      callStatus.innerText = 'Tap the mic button to respond';
    }, 500);
  };

  utter.onerror = (e) => {
    console.error("❌ TTS Error:", e);
    isTherapistSpeaking = false;
    micBtn.style.display = 'inline-block';
    callStatus.innerText = 'Tap mic button to respond';
  };

  try {
    synth.speak(utter);
  } catch (e) {
    console.error("❌ Failed to speak:", e);
    isTherapistSpeaking = false;
    micBtn.style.display = 'inline-block';
  }
}


//================== Speak Text with Gesture =========
function speakTextWithGesture(text) {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    // On iOS, wait for user gesture
    callStatus.innerText = "Tap to hear therapist...";
    
    const speakOnTap = function() {
      document.removeEventListener('click', speakOnTap);
      speakText(text);
    };
    
    document.addEventListener('click', speakOnTap, { once: true });
  } else {
    // Desktop: speak immediately
    speakText(text);
  }
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

// ================= UPDATED START CALL =================
function startCall() {
  if (!currentCallSessionId) return;

  trialActiveStart = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);

  callStatus.innerText = "Starting call...";
  startCallBtn.disabled = true;
  endCallBtn.disabled = false;
  continueBtn.style.display = "none";

  const session = callSessions[currentCallSessionId];
  
  if (session.messages.length === 0) {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      showTapToStart();
      
      // Set up tap to start the actual call
      const startCallOnTap = function() {
        document.removeEventListener('click', startCallOnTap);
        sendToTherapist("__init__");
      };
      
      document.addEventListener('click', startCallOnTap, { once: true });
    } else {
      sendToTherapist("__init__");
    }
  }
}
// ================= UPDATE END CALL FUNCTION =================
function endCall() {
  callStatus.innerText = translations["call_ended"] || "Call ended.";
  startCallBtn.disabled = false;
  endCallBtn.disabled = true;
  
  // Stop all speech activities
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    stopIOSLiveTranscription();
  } else {
    stopListening();
  }
  
  window.speechSynthesis.cancel();
  clearInterval(timerInterval);
}

// ================= UPDATED SEND TO THERAPIST =================
function sendToTherapist(message) {
  if (!message) return;

  const session = callSessions[currentCallSessionId];
  if (!session) return;

  if (message !== "__init__") {
    session.messages.push({ sender: "user", text: message });
    renderTranscript(session);
  }
  
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
  .then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((data) => {
    if (data.reply) {
      handleTherapistResponse(data.reply);
      if (!titleGenerated && message !== "__init__") {
        autoRenameCallSession();
      }
    }
  })
  .catch((err) => {
    console.error("❌ Fetch error:", err);
    callStatus.innerText = "❌ Connection error. Tap to retry.";
    isWaitingForTap = true;
  });
}



// ================= IOS HANDLING =================
let liveStream, liveRecorder;
let liveTranscriptDiv;
let liveTextBuffer = "";
let liveTranscribeTimer = null;

// ================= UPDATED IOS LIVE TRANSCRIPTION =================
async function startIOSLiveTranscription() {
  try {
    console.log("🎤 Starting iOS live transcription");
    
    // Request microphone permission with user gesture
    liveStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000
      }
    });

    // Use AAC format for better iOS compatibility
    const options = { 
      mimeType: 'audio/mp4',
      audioBitsPerSecond: 128000
    };
    
    liveRecorder = new MediaRecorder(liveStream, options);

    // Create speaking bubble
    liveTranscriptDiv = document.querySelector(".msg.user.speaking");
    if (!liveTranscriptDiv) {
      liveTranscriptDiv = document.createElement("div");
      liveTranscriptDiv.className = "msg user speaking";
      liveTranscriptDiv.innerHTML = `
        <strong>${translations["you_speaking"] || "You (speaking)"}:</strong> 
        <span class="live-text">Listening...</span>`;
      transcriptBox.appendChild(liveTranscriptDiv);
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    }

    liveTextBuffer = "";

    liveRecorder.ondataavailable = async (e) => {
      if (e.data.size > 1000) {
        const formData = new FormData();
        formData.append("audio", e.data, "chunk.m4a");

        try {
          const res = await fetch("/trial_transcribe", { 
            method: "POST", 
            body: formData 
          });
          
          if (res.ok) {
            const data = await res.json();
            if (data.text && data.text.trim()) {
              liveTextBuffer = data.text;
              liveTranscriptDiv.querySelector(".live-text").innerText = liveTextBuffer;
              transcriptBox.scrollTop = transcriptBox.scrollHeight;
              resetSilenceTimer();
            }
          }
        } catch (err) {
          console.error("❌ Transcription error:", err);
        }
      }
    };

    liveRecorder.start(1000); // Collect data every second
    callStatus.innerText = "🎤 Listening... Speak now";
    resetSilenceTimer();

  } catch (err) {
    console.error("❌ iOS mic error:", err);
    callStatus.innerText = "❌ Microphone access denied. Please allow microphone permission.";
    micBtn.style.display = 'none';
  }
}

function stopIOSLiveTranscription() {
  if (liveRecorder && liveRecorder.state === "recording") {
    clearInterval(liveTranscribeTimer);
    liveRecorder.stop();
    liveStream.getTracks().forEach(t => t.stop());
  }

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

function onTherapistFinished() {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    startIOSLiveTranscription();
  } else {
    startListening();
  }
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    console.log("⏹ Auto stop: silence detected");
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      stopIOSLiveTranscription();
    } else {
      stopListening();
    }
  }, 6000);
}

// ================= SESSION MGMT =================
function addNewCallSession() {
  if (trialSessionsUsed >= TRIAL_MAX_SESSIONS) {
    showTrialLimitBanner();
    alert(translations["call_limit_reached"] || "Trial limit reached.");
    return;
  }

  const id = Date.now().toString();

  callSessions[id] = {
    name: translations["new_call_session"] || "New Call",
    messages: [],
    _titleGenerated: false,
    kind: "trial_call"
  };

  currentCallSessionId = id;
  trialSessionsUsed++;
  titleGenerated = false;

  saveCallState();
  renderCallSessions();
  loadCallSession(id);
  startCall(); // ✅ immediately start the call after creating
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

document.addEventListener("DOMContentLoaded", async () => {
  await loadTranslations(localStorage.getItem("selectedLanguage") || "en");

  // Ensure voices are available
  speechSynthesis.onvoiceschanged = () => {
    if (!selectedVoice) {
      selectedVoice = speechSynthesis.getVoices().find(v => v.lang.startsWith("en")) || null;
    }
    initVoices();
  };

  await initVoices();
  renderCallSessions();
  updateSessionsLeft();

  if (currentCallSessionId && callSessions[currentCallSessionId]) {
    loadCallSession(currentCallSessionId);
  } else {
    renderTranscript(null);
    updateButtonStates();
  }

  // ✅ Hook buttons (single source of truth)
  if (newCallSessionBtn) {
    newCallSessionBtn.addEventListener("click", () => {
      console.log("🟢 New session button clicked");
      addNewCallSession();
    });
  }

  if (startCallBtn) {
    startCallBtn.addEventListener("click", async () => {
      try {
        // 🔓 Unlock audio on iOS Safari
        const dummyUtter = new SpeechSynthesisUtterance("Starting call");
        dummyUtter.volume = 0;
        window.speechSynthesis.speak(dummyUtter);
      } catch (e) {
        console.warn("Audio unlock failed:", e);
      }

      // 🔓 Unlock mic (desktop only)
      if ("webkitSpeechRecognition" in window && !/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        try {
          let dummy = new webkitSpeechRecognition();
          dummy.start();
          setTimeout(() => dummy.stop(), 50);
        } catch (e) {
          console.warn("Mic unlock failed:", e);
        }
      }

      console.log("🟢 Starting call…");
      startCall();

      if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        startIOSLiveTranscription();
      }
    });
  }

  if (endCallBtn) {
    endCallBtn.addEventListener("click", () => {
      console.log("🛑 Ending call…");
      endCall();
    });
  }

  if (continueBtn) {
    continueBtn.addEventListener("click", () => {
      console.log("🔁 Continue clicked");
      continueBtn.style.display = "none";
      hideUserTurn();
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        startIOSLiveTranscription();
      } else {
        startListening();
      }
    });
  }

   // Add this at the end:
  setupTapToHear();
  // ======== PUT IT RIGHT HERE - AT THE VERY END ========
  // Add click event to entire document to capture user gestures
  document.addEventListener('click', function() {
    unlockAudioOnIOS();
  }, { once: true });

  // Also add to start call button
  startCallBtn.addEventListener('click', unlockAudioOnIOS);
  // ======== END OF ADDITION ========

}); // <-- This closing brace ends the DOMContentLoaded event listener

// ================= SPEECH RECOGNITION =================
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

// ================= MIC BUTTON HANDLING =================
const micBtn = document.getElementById("micBtn");
let mediaRecorder, audioChunks = [];
let isRecording = false;

async function startRecording(auto = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const mimeType = isSafari ? "audio/mp4" : "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      clearTimeout(silenceTimer);
      setTimeout(async () => {
        const ext = isSafari ? "mp4" : "webm";
        const blob = new Blob(audioChunks, { type: `audio/${ext}` });

        if (blob.size < 2000) {
          callStatus.innerText = "⚠️ Too short, try again.";
          return;
        }

        const formData = new FormData();
        formData.append("audio", blob, `voice.${ext}`);

        try {
          const res = await fetch("/trial_transcribe", { method: "POST", body: formData });
          const data = await res.json();

          if (data.text) {
            const div = document.createElement("div");
            div.className = "msg user";
            div.innerHTML = `<strong>${translations["you"] || "You"}:</strong> ${data.text}`;
            transcriptBox.appendChild(div);
            transcriptBox.scrollTop = transcriptBox.scrollHeight;

            sendToTherapist(data.text);
            callStatus.innerText = "✅ Sent to therapist";
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

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.textContent = "🎤 Start Talking";
    callStatus.innerText = "⏳ Processing...";
  }
}

// ================= MIC BUTTON HANDLING =================
micBtn.onclick = () => {
  if (!isRecording) {
    startIOSRecording();
  } else {
    stopIOSRecording();
  }
};

async function startIOSRecording() {
  try {
    isRecording = true;
    micBtn.textContent = '⏹️ Stop';
    micBtn.style.background = '#ff4444';
    callStatus.innerText = '🎤 Recording...';
    
    await startIOSLiveTranscription();
    
  } catch (error) {
    console.error('❌ Recording failed:', error);
    isRecording = false;
    micBtn.textContent = '🎤 Try Again';
    micBtn.style.background = '';
    callStatus.innerText = '❌ Recording failed';
  }
}

function stopIOSRecording() {
  if (liveRecorder && liveRecorder.state === 'recording') {
    liveRecorder.stop();
    liveStream.getTracks().forEach(track => track.stop());
  }
  
  isRecording = false;
  micBtn.textContent = '🎤 Start Talking';
  micBtn.style.background = '';
  micBtn.style.display = 'none'; // Hide after recording
  
  if (liveTextBuffer.trim()) {
    sendToTherapist(liveTextBuffer);
    callStatus.innerText = '✅ Sent to therapist';
  } else {
    callStatus.innerText = '❌ No speech detected';
  }
}

// ================= IOS SAFARI FIXES =================
let audioContextUnlocked = false;

function unlockAudioOnIOS() {
  if (audioContextUnlocked) return;
  
  try {
    const buffer = new AudioContext();
    const source = buffer.createBufferSource();
    source.buffer = buffer.createBuffer(1, 1, 22050);
    source.connect(buffer.destination);
    source.start(0);
    
    if (buffer.state === 'suspended') {
      buffer.resume().then(() => {
        console.log('Audio context resumed');
        audioContextUnlocked = true;
      });
    }
  } catch (e) {
    console.warn('Audio context unlock failed:', e);
  }
  
  try {
    const audio = new Audio();
    audio.volume = 0;
    audio.play().then(() => {
      console.log('HTML audio unlocked');
      audioContextUnlocked = true;
    });
  } catch (e) {
    console.warn('HTML audio attempt failed:', e);
  }
}

// ================= IOS TAP HANDLING =================
let isWaitingForTap = false;

function showTapToStart() {
  callStatus.innerText = "👆 Tap anywhere to hear therapist";
  callStatus.style.color = "#00ff9f";
  callStatus.style.fontWeight = "bold";
  
  // Show visual prompt
  showIOSTapPrompt();
  isWaitingForTap = true;
}

function handleTherapistResponse(text) {
  const session = callSessions[currentCallSessionId];
  session.messages.push({ sender: "therapist", text: text });
  renderTranscript(session);
  saveCallState();

  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    // ✅ iOS: require tap for first time only
    if (!audioContextUnlocked) {
      showTapToStart();
    } else {
      speakText(text);
    }
  } else {
    // ✅ Other devices: speak immediately
    speakText(text);
  }
}


// ================= TAP-TO-HEAR FUNCTION =================
function setupTapToHear() {
  document.addEventListener('click', function tapHandler(e) {
    if (!isWaitingForTap) return;
    
    // Don't trigger on button clicks
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    
    isWaitingForTap = false;
    callStatus.innerText = "Therapist is speaking...";
    
    // Get the last therapist message and speak it
    const session = callSessions[currentCallSessionId];
    if (session && session.messages.length > 0) {
      const lastTherapistMsg = session.messages
        .slice().reverse()
        .find(m => m.sender === "therapist");
      
      if (lastTherapistMsg) {
        speakText(lastTherapistMsg.text);
      }
    }
    
    // Remove this listener after use
    document.removeEventListener('click', tapHandler);
  });
}