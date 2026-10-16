// The Light/Dark/Auto choice, shared by the console and the docs. It lives in
// localStorage, which the server can't see, so pages read it through
// useSyncExternalStore with "system" as the server value. layout.tsx applies
// a saved choice before first paint (same key), so the page doesn't flash.

export type ThemePref = "system" | "light" | "dark";

const THEME_KEY = "ai-thun-theme";
const THEME_EVENT = "ai-thun-theme-change";

export function subscribeTheme(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(THEME_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(THEME_EVENT, callback);
  };
}

export function getThemePref(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function setThemePref(t: ThemePref) {
  try {
    if (t === "system") {
      localStorage.removeItem(THEME_KEY);
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem(THEME_KEY, t);
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch {
    // storage blocked — the choice just won't persist
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
