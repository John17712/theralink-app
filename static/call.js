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
let iosMicUnlocked = false;
let recognition;
let selectedVoice = null;
let voiceGender = localStorage.getItem("therapistVoice") || "female";
let silenceTimer = null;
let longSilenceTimer = null;
let isTherapistSpeaking = false;
let fullTranscript = "";
let titleGenerated = false;
let translations = {};

let audioProcessor = null;
let mediaStream = null;


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
    // 💻 Desktop/Android: prefer Web Speech, else fall back to MediaRecorder
    else {
      if ("webkitSpeechRecognition" in window) {
      startListening();
    } else {
      startRecording(true);
    }
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

// 🔓 One-time iOS mic unlock helper
async function unlockIOSMicOnce() {
  try {
    // If already unlocked and the stream is still live, reuse it
    if (
      iosMicUnlocked &&
      mediaStream &&
      mediaStream.getAudioTracks().some(t => t.readyState === "live")
    ) {
      return mediaStream;
    }

    // 1) Ask for mic (don’t force sampleRate; Safari may ignore it anyway)
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    iosMicUnlocked = true; // ✅ mark as unlocked
    return mediaStream;

  } catch (err) {
    iosMicUnlocked = false;
    console.error("❌ iOS mic unlock failed:", err);
    if (typeof callStatus !== "undefined" && callStatus) {
      callStatus.innerText = "⚠️ Microphone access blocked or unavailable.";
    }
    throw err;
  }
}


// 🔘 Start Call — single consolidated click handler
startCallBtn.addEventListener("click", async () => {
  // 1) Unlock Web Speech (TTS) on first user gesture
  try {
    const unlockUtter = new SpeechSynthesisUtterance(" ");
    speechSynthesis.speak(unlockUtter);
  } catch (e) {
    console.warn("Audio unlock failed:", e);
  }

  // 2) Unlock microphone
  try {
    if (isIOS && !iosMicUnlocked) {
      // Prefer the helper if your code defines it elsewhere
      if (typeof unlockIOSMicOnce === "function") {
        await unlockIOSMicOnce();
      } else {
        // Fallback: request mic once and mark unlocked
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
        iosMicUnlocked = true;
      }
    } else if ("webkitSpeechRecognition" in window && !isIOS) {
      // Desktop Chrome/Edge: quick start/stop to grant mic permission
      try {
        const dummy = new webkitSpeechRecognition();
        dummy.start();
        setTimeout(() => dummy.stop(), 50);
      } catch (e) {
        console.warn("Mic unlock (desktop) failed:", e);
      }
    }
  } catch (e) {
    console.warn("Mic unlock attempt failed:", e);
  }

  // 3) Preload the turn ding to avoid autoplay blocking later
  try {
    const ding = new Audio("/static/sounds/turn.mp3");
    ding.play().then(() => ding.pause()).catch(() => {});
  } catch (_) {}

  // 4) Actually start the call
  startCall();
});

// 🛑 End Call
endCallBtn.addEventListener("click", endCall);

// 🆕 New Call Session
newCallSessionBtn.addEventListener("click", addNewCallSession);

// ▶️ Continue listening (after long silence)
continueBtn.addEventListener("click", async () => {
  continueBtn.style.display = "none";
  hideUserTurn();

  if (isIOS) {
    try {
      await startIOSRecording();
    } catch (e) {
      console.warn("iOS continue failed:", e);
      callStatus.innerText = "⚠️ Microphone access blocked or unavailable.";
    }
  } else {
    // Desktop/Android
    if ("webkitSpeechRecognition" in window) {
      startListening();
    } else {
      // Fallback to MediaRecorder path
      startRecording(true);
    }
  }
});


// 🔁 If a dashboard opened this page with a specific session id, load it
(function useSidFromDashboard() {
  const sid = localStorage.getItem("openDbCallSid");
  if (!sid) return;
  localStorage.removeItem("openDbCallSid");

  if (typeof window.selectCallSessionById === "function") {
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
// ✅ Start recording (manual or auto) — fixed MIME/ext + safe cleanup
async function startRecording(auto = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Capability probe for best available container/codec
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",  // Safari
      "audio/aac"   // Safari fallback
    ];
    const mimeType = (MediaRecorder.isTypeSupported)
      ? (candidates.find(t => MediaRecorder.isTypeSupported(t)) || "")
      : "";

    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream); // let the browser decide

    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      setMicBlinking(false);
      clearTimeout(silenceTimer);

      // Prefer the actual type the recorder produced
      const producedType =
        mediaRecorder.mimeType ||
        (audioChunks[0] && audioChunks[0].type) ||
        "audio/webm";

      // Pick a sensible file extension from the MIME
      const ext = producedType.includes("mp4")
        ? "mp4"
        : producedType.includes("aac")
        ? "aac"
        : "webm";

      // Build a single blob with the *real* type
      const blob = new Blob(audioChunks, { type: producedType });

      // 🔎 Debug info before upload
      console.log("🎙️ MediaRecorder blob:", {
        size: blob.size,
        type: blob.type,
        mimeType: mediaRecorder.mimeType
      });

      // Always stop tracks to release the mic
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}

      if (blob.size === 0) {
        callStatus.innerText = "⚠️ Empty audio, try again.";
        console.warn("❌ Skipping empty blob upload");
        return;
      }

      const formData = new FormData();
      formData.append("audio", blob, `voice.${ext}`);

      try {
        console.log("📡 Uploading blob → /transcribe");
        const res = await fetch("/transcribe", { method: "POST", body: formData });
        console.log("📡 Server response status:", res.status);
        const data = await res.json();
        console.log("📜 Server response JSON:", data);

        if (data.text) {
          const div = document.createElement("div");
          div.className = "msg user";
          div.innerHTML = `<strong>${translations["you"] || "You"}:</strong> ${data.text}`;
          transcriptBox.appendChild(div);
          transcriptBox.scrollTop = transcriptBox.scrollHeight;

          sendToTherapist(data.text);
          callStatus.innerText = "✅ Sent to therapist";
        } else {
          callStatus.innerText = "⚠️ Could not transcribe audio.";
        }
      } catch (err) {
        console.error("❌ Transcription error:", err);
        callStatus.innerText = "⚠️ Failed to process audio.";
      }
    };

    mediaRecorder.start(250); // request chunks every 250ms
 // you can pass a timeslice if you want periodic chunks
    isRecording = true;

    if (auto) {
      setMicBlinking(true);
      callStatus.innerText = "🎙️ Listening...";
      resetSilenceTimer();        // this remains a fixed 6s window
    } else {
      callStatus.innerText = "🎙️ Recording... Tap again to stop.";
      micBtn.textContent = "⏹ Stop Talking";
    }
  } catch (err) {
    console.error("Mic error:", err);
    callStatus.innerText = "⚠️ Microphone access denied.";
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

// ✅ Update mic button handler for iOS
micBtn.onclick = () => {
  if (isIOS) {
    if (!isRecording) {
      startIOSRecording();
    } else {
      stopIOSRecording();
    }
  } else {
    // Desktop handling (your existing code)
    if (!isRecording) {
      startRecording(false);
    } else {
      stopRecording();
    }
  }
};


// ✅ Hook: Therapist finished → auto start mic
function onTherapistFinished() {
  if (isRecording) return;

  if (isIOS) {
    if (iosMicUnlocked) {
      // We already have mic permission from a user gesture → auto-start
      startIOSRecording();
    } else {
      // No prior user gesture → prompt the user
      continueBtn.style.display = "inline-block";
      showUserTurn();
      playTurnSound();
    }
  } else {
    // Desktop/Android path with Web Speech / MediaRecorder
    startRecording(true);
  }
}




// ---------------- 🎤 iOS Live Recording (Improved) ----------------

let audioContext = null;

// ✅ Replace your entire startIOSRecording() with THIS version
async function startIOSRecording() {
  try {
    if (isRecording) return;

    // Ensure mic permission + live stream (sets global `mediaStream`)
    await unlockIOSMicOnce();

    // Create (and resume) AudioContext — iOS often starts "suspended"
    const AC = window.AudioContext || window.webkitAudioContext;
    audioContext = new AC({ sampleRate: 44100 }); // hint only; iOS may use a different SR
    if (audioContext.state === "suspended") {
      try { await audioContext.resume(); } catch (_) {}
    }

    // Source + ScriptProcessor (kept for iOS Safari compatibility)
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    audioProcessor = processor;

    // Flip to recording BEFORE first buffer arrives
    isRecording = true;

    // Collect PCM16 chunks
    audioChunks = [];
    processor.onaudioprocess = (event) => {
      if (!isRecording) return;
      const input = event.inputBuffer.getChannelData(0);
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      audioChunks.push(out);
    };

    // Keep the graph alive without audible output (iOS quirk)
    const mute = audioContext.createGain();
    mute.gain.value = 0;

    // Keep refs for cleanup in stopIOSRecording()
    processor._source = source;
    processor._mute  = mute;

    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);

    // UI
    callStatus.innerText = "🎙️ Recording... Tap to stop.";
    micBtn.textContent = "⏹ Stop";
    setMicBlinking(true);

    // Debug actual sample rate chosen by iOS
    console.log(`[iOS] AudioContext sampleRate=${audioContext.sampleRate}`);

  } catch (err) {
    console.error("❌ iOS recording error:", err);
    callStatus.innerText = "⚠️ Microphone access blocked or unavailable.";
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    isRecording = false;
  }
}




async function stopIOSRecording() {
  if (!isRecording) return;
  isRecording = false;

  // Let the last ScriptProcessor buffers arrive
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const sr = (audioContext && audioContext.sampleRate) ? audioContext.sampleRate : 44100;

  // Disconnect graph (but don't stop tracks yet)
  if (audioProcessor) {
    try { audioProcessor.disconnect(); } catch (_) {}
    try { audioProcessor._source && audioProcessor._source.disconnect(); } catch (_) {}
    try { audioProcessor._mute && audioProcessor._mute.disconnect(); } catch (_) {}
    audioProcessor = null;
  }

  micBtn.textContent = "🎤 Start";
  setMicBlinking(false);
  callStatus.innerText = "⏳ Processing...";

  if (!Array.isArray(audioChunks) || audioChunks.length === 0) {
    callStatus.innerText = "⚠️ No audio captured. Please try again.";
    // Now it’s safe to stop tracks/close AC
    try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { audioContext && (await audioContext.close()); } catch (_) {}
    mediaStream = null; audioContext = null;
    return;
  }

  // Combine PCM16 chunks
  const totalLength = audioChunks.reduce((t, c) => t + c.length, 0);
  const combined = new Int16Array(totalLength);
  let off = 0; for (const c of audioChunks) { combined.set(c, off); off += c.length; }

  console.log(`[iOS] chunks=${audioChunks.length} samples=${totalLength} sr=${sr}`);

  const wavBlob = encodeWAV(combined, sr);
  console.log("📦 iOS WAV size (bytes):", wavBlob.size);

  // Now stop tracks and close the context
  try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { audioContext && (await audioContext.close()); } catch (_) {}
  mediaStream = null; audioContext = null;

  if (wavBlob.size === 0) {
  console.warn("❌ WAV blob is empty before upload");
  callStatus.innerText = "⚠️ Empty recording (Safari). Try again.";
  return;
}

  // Upload
  await sendAudioToServer(wavBlob);
}


// ✅ Convert Int16Array to WAV format
function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  // → Coerce to Int16
  let pcm;
  if (samples instanceof Int16Array) {
    pcm = samples;
  } else {
    const src = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    pcm = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
  }

  const dataSize = pcm.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv  = new DataView(buf);

  let p = 0;
  const w8 = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };

  // RIFF header
  w8('RIFF'); dv.setUint32(p, 36 + dataSize, true); p += 4;
  w8('WAVE');

  // fmt chunk
  w8('fmt '); dv.setUint32(p, 16, true); p += 4;         // PCM header size
  dv.setUint16(p, 1, true);                 p += 2;      // PCM
  dv.setUint16(p, numChannels, true);       p += 2;
  dv.setUint32(p, sampleRate, true);        p += 4;
  dv.setUint32(p, byteRate, true);          p += 4;
  dv.setUint16(p, blockAlign, true);        p += 2;
  dv.setUint16(p, bytesPerSample * 8, true);p += 2;

  // data chunk
  w8('data'); dv.setUint32(p, dataSize, true); p += 4;

  for (let i = 0; i < pcm.length; i++) { dv.setInt16(p, pcm[i], true); p += 2; }

  // 🔧 Safari quirk: wrap ArrayBuffer in a Uint8Array
  return new Blob([new Uint8Array(buf)], { type: 'audio/wav' });
}



// ✅ Send audio to server
async function sendAudioToServer(audioBlob) {
  console.log("📦 Audio blob size:", audioBlob.size, "type:", audioBlob.type);
  
  if (audioBlob.size === 0) {
    callStatus.innerText = "⚠️ Empty recording. Please try again.";
    return;
  }
  
  const formData = new FormData();
  formData.append("audio", audioBlob, `recording-${Date.now()}.wav`);

  
  try {
    console.log("📡 Sending audio to server...");
    const response = await fetch("/transcribe", {
      method: "POST",
      body: formData
    });
    
    console.log("📋 Server response status:", response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Server error:", errorText);
      throw new Error(`Server returned ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    console.log("📝 Transcription result:", data);
    
    if (data.text && data.text.trim() !== "") {
      // Display the transcribed text
      const div = document.createElement("div");
      div.className = "msg user";
      div.innerHTML = `<strong>${translations["you"] || "You"}:</strong> ${data.text}`;
      transcriptBox.appendChild(div);
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
      
      // Send to therapist
      sendToTherapist(data.text);
      callStatus.innerText = "✅ Sent to therapist";
    } else if (data.error) {
      callStatus.innerText = `⚠️ ${data.error}`;
    } else {
      callStatus.innerText = "⚠️ Could not transcribe audio.";
    }
    
  } catch (err) {
    console.error("❌ Transcription error:", err);
    callStatus.innerText = "⚠️ Failed to process audio. Please try again.";
  }
}
