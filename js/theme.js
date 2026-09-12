/* theme.js — v3 city theme system (classic / seattle / boston).
 * The data-theme attribute is applied pre-paint by an inline script in <head>;
 * this module only wires the picker, persists the choice, and exposes
 * playCoverOpen() for the home-page opening transition. */

export const THEME_KEY = "gesturebook:theme";
const THEMES = ["classic", "seattle", "boston"];

export function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return THEMES.includes(t) ? t : "classic";
}

function applyTheme(theme, { persist = true } = {}) {
  const next = THEMES.includes(theme) ? theme : "classic";
  if (next === "classic") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", next);
  }
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* non-fatal */ }
  }
  document.querySelectorAll(".theme-opt").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.setTheme === next));
  });
}

export function initThemePicker() {
  const picker = document.getElementById("theme-picker");
  if (!picker) return;
  applyTheme(currentTheme(), { persist: false });   // sync aria state
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-set-theme]");
    if (btn) applyTheme(btn.dataset.setTheme);
  });
}

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

/* Cover-swing opening transition: returns a promise resolving after the
 * cover animation (or immediately under reduced motion). */
export function playCoverOpen(dropzone) {
  if (!dropzone || dropzone.classList.contains("cover-open")) return Promise.resolve();
  if (REDUCED.matches) return Promise.resolve();   // cross-fade handled by CSS
  dropzone.classList.add("cover-open");
  return new Promise((resolve) => {
    const cover = dropzone.querySelector(".bc-cover");
    const done = () => {
      cover && cover.removeEventListener("transitionend", done);
      clearTimeout(timer);
      resolve();
    };
    cover && cover.addEventListener("transitionend", done);
    const timer = setTimeout(done, 850);           // safety net past 700ms swing
  });
}
