// ===== Unified Migration for Trial Sessions (Call + Chat) =====
async function migrateAllTrialSessions() {
  try {
    // Collect both call + chat sessions from localStorage
    const callSessions = JSON.parse(localStorage.getItem("trialCallSessions")) || {};
    const chatSessions = JSON.parse(localStorage.getItem("trialChatSessions")) || {};

    if (
      Object.keys(callSessions).length === 0 &&
      Object.keys(chatSessions).length === 0
    ) {
      console.log("ℹ️ No trial sessions to migrate");
      return;
    }

    const payload = { sessions: {} };

    // --- Handle Chat Sessions ---
    for (const [sid, s] of Object.entries(chatSessions)) {
      payload.sessions[sid] = {
        // preserve multilingual name object if available
        name: s.name || { en: "Trial Chat" },
        messages: s.messages || []
      };
    }

    // --- Handle Call Sessions ---
    for (const [sid, s] of Object.entries(callSessions)) {
      let displayName = "Trial Call";
      if (typeof s.name === "string") {
        displayName = s.name;
      } else if (s.name && typeof s.name === "object") {
        // if somehow stored as multilingual, fall back to English or first available
        displayName = s.name.en || Object.values(s.name)[0] || "Trial Call";
      }

      payload.sessions[sid] = {
        name: displayName, // always plain string
        messages: s.messages || []
      };
    }

    // --- Send to backend ---
    const res = await fetch("/migrate_trials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const isJSON = res.headers.get("content-type")?.includes("application/json");
    if (!isJSON) return;

    const data = await res.json();
    if (data.success) {
      console.log("✅ Trial sessions migrated successfully");
      // optional: clear localStorage after migration
      // localStorage.removeItem("trialChatSessions");
      // localStorage.removeItem("trialCallSessions");
    } else {
      console.warn("⚠️ Migration failed:", data.message);
    }
  } catch (err) {
    console.error("❌ Migration error:", err);
  }
}

// Expose globally
window.__migrateTrialSessions = migrateAllTrialSessions;
