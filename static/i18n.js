// static/js/i18n.js
(function(global) {
  let translations = {};
  let currentLang = localStorage.getItem("selectedLanguage") || "en";

  // Expose globally
  global.i18n = {
    getLang: () => currentLang,
    setLang: (lang) => {
      currentLang = lang;
      localStorage.setItem("selectedLanguage", lang);
      document.documentElement.lang = lang;
      loadTranslations(lang);
    },
    translate: (key) => translations[key] || key
  };

  async function loadTranslations(lang) {
    try {
      const res = await fetch(`/static/lang/${lang}.json`);
      if (!res.ok) throw new Error("Could not load translations");
      translations = await res.json();

      // Apply to DOM
      document.querySelectorAll("[data-i18n]").forEach(el => {
        const k = el.getAttribute("data-i18n");
        if (translations[k]) el.textContent = translations[k];
      });

      document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        const k = el.getAttribute("data-i18n-placeholder");
        if (translations[k]) el.setAttribute("placeholder", translations[k]);
      });

      document.body.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    } catch (err) {
      console.error("Error loading language:", err);
    }
  }

  // Init on load
  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.lang = currentLang;
    loadTranslations(currentLang);

    const selector = document.getElementById("languageSelector");
    if (selector) {
      selector.value = currentLang;
      selector.addEventListener("change", (e) => {
        global.i18n.setLang(e.target.value);
      });
    }
  });
})(window);
