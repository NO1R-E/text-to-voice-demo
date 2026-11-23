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
    expect([...document.querySelectorAll(".hbar-label")].map((e) => e.textContent)).toEqual(["often", "rarely"]);
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

  it("resets play history after confirming", async () => {
    const ui = await boot();
    ui.add("one");
    ui.speak("one", 2);
    ui.openDashboard();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("2"));
    ui.$<HTMLButtonElement>("#clear-stats").click();
    ui.$<HTMLButtonElement>("#confirm-yes").click();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("0"));
  });
});
