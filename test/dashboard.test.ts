import { describe, expect, it, vi } from "vitest";

async function boot() {
  await import("../src/main");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const add = (text: string) => {
    $<HTMLTextAreaElement>("#new-text").value = text;
    $<HTMLFormElement>("#add-form").requestSubmit();
  };
  const speak = (text: string, times: number) => {
    for (let i = 0; i < times; i++) {
      const b = [...document.querySelectorAll(".bubble")].find((x) => x.querySelector(".text")!.textContent === text)!;
      b.querySelector<HTMLButtonElement>('[data-act="speak"]')!.click(); // start
      b.ownerDocument.querySelector<HTMLButtonElement>(`[data-id="${b.getAttribute("data-id")}"] [data-act="speak"]`)!.click(); // stop
    }
  };
  const openDashboard = () => $<HTMLButtonElement>('[data-tab="dashboard"]').click();
  return { $, add, speak, openDashboard };
}

describe("dashboard (from the database)", () => {
  it("shows the most played text, ranking and totals", async () => {
    const ui = await boot();
    ui.add("rarely");
    ui.add("often");
    ui.speak("often", 3);
    ui.speak("rarely", 1);
    ui.openDashboard();

    await vi.waitFor(() => {
      expect(ui.$(".tile.wide .value").textContent).toBe("often");
    });
    expect([...document.querySelectorAll('[data-card="top"] .hbar-label')].map((e) => e.textContent)).toEqual(["often", "rarely"]);
    expect(ui.$('[data-stat="plays"]').textContent).toBe("4");
    expect(ui.$('[data-stat="texts"]').textContent).toBe("2");
    expect(document.querySelectorAll("table tbody tr")).toHaveLength(2);
  });

  it("updates live when a text is played while the dashboard is open", async () => {
    const ui = await boot();
    ui.add("one");
    ui.openDashboard();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("0"));
    ui.speak("one", 2);
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("2"));
  });

  it("has no way to reset or delete stats", async () => {
    const ui = await boot();
    ui.add("one");
    ui.speak("one", 1);
    ui.openDashboard();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("1"));
    expect(document.querySelector("#clear-stats, #confirm-yes")).toBeNull();
    expect(document.getElementById("tab-dashboard")!.textContent).not.toMatch(/reset/i);
  });

  it("shows the cards: texts played, Thai/English, busiest hours, top voices, whose texts", async () => {
    const ui = await boot();
    ui.add("hello");
    ui.add("สวัสดี");
    ui.speak("hello", 2);
    ui.speak("สวัสดี", 1);
    ui.openDashboard();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("3"));
    expect(ui.$('[data-stat="distinct"]').textContent).toBe("2"); // Mine: different texts you played
    const langs = ui.$('[data-card="languages"]');
    expect(langs.textContent).toMatch(/Thai/);
    expect(langs.textContent).toMatch(/English/);
    expect(langs.querySelectorAll(".seg")).toHaveLength(2);
    expect(ui.$('[data-card="hours"]').querySelectorAll(".hour")).toHaveLength(24);
    expect(ui.$('[data-card="voices"]').querySelectorAll(".hbar-row").length).toBeGreaterThan(0);
    expect(ui.$('[data-card="whose"]').textContent).toMatch(/Your own/);
    expect(document.querySelector('[data-card="authors"]')).toBeNull(); // Overall only
  });
});
