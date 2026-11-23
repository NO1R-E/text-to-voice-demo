/**
 * Theme: "auto" follows the browser/OS (prefers-color-scheme); "light"/"dark" force it.
 * A forced choice is stamped as <html data-theme="…">; CSS keys the palette off that.
 */
export type Theme = "auto" | "light" | "dark";
export const THEMES: readonly Theme[] = ["auto", "light", "dark"];
const KEY = "task-voice:theme";

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY) as Theme | null;
    return t && THEMES.includes(t) ? t : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(t: Theme): void {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}

export function saveTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}
