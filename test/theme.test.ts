import { describe, expect, it, vi } from "vitest";

const root = () => document.documentElement;
const btn = (t: string) => document.querySelector<HTMLButtonElement>(`[data-theme-choice="${t}"]`)!;

async function boot() {
  await import("../src/main");
}

describe("theme", () => {
  it("defaults to Auto: no forced theme, follows the browser", async () => {
    root().removeAttribute("data-theme");
    await boot();
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(btn("auto").getAttribute("aria-pressed")).toBe("true");
  });

  it("lets the user force Dark or Light and remembers it", async () => {
    await boot();
    btn("dark").click();
    expect(root().dataset.theme).toBe("dark");
    expect(btn("dark").getAttribute("aria-pressed")).toBe("true");
    expect(btn("auto").getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("task-voice:theme")).toBe("dark");

    btn("light").click();
    expect(root().dataset.theme).toBe("light");
    expect(localStorage.getItem("task-voice:theme")).toBe("light");
  });

  it("going back to Auto removes the forced theme", async () => {
    await boot();
    btn("dark").click();
    btn("auto").click();
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("task-voice:theme")).toBe("auto");
  });

  it("applies the saved choice on the next visit", async () => {
    localStorage.setItem("task-voice:theme", "dark");
    root().removeAttribute("data-theme");
    await boot();
    expect(root().dataset.theme).toBe("dark");
    expect(btn("dark").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores a garbage saved value", async () => {
    localStorage.setItem("task-voice:theme", "purple");
    root().removeAttribute("data-theme");
    await boot();
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(btn("auto").getAttribute("aria-pressed")).toBe("true");
  });

  it("theme helpers work on their own", async () => {
    vi.resetModules();
    const { applyTheme, loadTheme } = await import("../src/theme");
    applyTheme("light");
    expect(root().dataset.theme).toBe("light");
    applyTheme("auto");
    expect(root().hasAttribute("data-theme")).toBe(false);
    localStorage.setItem("task-voice:theme", "dark");
    expect(loadTheme()).toBe("dark");
  });
});
