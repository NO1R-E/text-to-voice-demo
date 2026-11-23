import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./setup";

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const texts = () => [...document.querySelectorAll(".bubble .text")].map((e) => e.textContent);
  const add = (text: string) => {
    $<HTMLTextAreaElement>("#new-text").value = text;
    $<HTMLFormElement>("#add-form").requestSubmit();
  };
  const search = (q: string) => {
    const input = $<HTMLInputElement>("#search");
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const choose = (sel: string, value: string) => {
    const s = $<HTMLSelectElement>(sel);
    s.value = value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const play = (text: string) => {
    const id = store.texts.find((t) => t.text === text)!.id;
    store.recordPlay(id, text.length);
  };
  return { $, store, texts, add, search, choose, play };
}

describe("search", () => {
  it("filters texts as you type (case-insensitive, Thai too)", async () => {
    const ui = await boot();
    ui.add("Buy milk");
    ui.add("Call mom");
    ui.add("ซื้อนม");
    ui.search("MILK");
    expect(ui.texts()).toEqual(["Buy milk"]);
    ui.search("นม");
    expect(ui.texts()).toEqual(["ซื้อนม"]);
    ui.search("");
    expect(ui.texts()).toHaveLength(3);
  });

  it("shows how many match and a friendly empty state", async () => {
    const ui = await boot();
    ui.add("one");
    ui.add("two");
    ui.search("on");
    expect(ui.$("#count").textContent).toBe("1 of 2");
    ui.search("zzz");
    expect(ui.texts()).toEqual([]);
    expect(ui.$("#list .empty").textContent).toMatch(/No texts match/);
  });
});

describe("sort", () => {
  it("defaults to most played, and can switch to newest/oldest", async () => {
    const ui = await boot();
    ui.add("old");
    ui.add("middle");
    ui.add("new");
    ui.play("old");
    ui.play("old");
    ui.play("middle");
    expect(ui.$<HTMLSelectElement>("#sort").value).toBe("played");
    expect(ui.texts()).toEqual(["old", "middle", "new"]);

    ui.choose("#sort", "newest");
    expect(ui.texts()).toEqual(["new", "middle", "old"]);
    ui.choose("#sort", "oldest");
    expect(ui.texts()).toEqual(["old", "middle", "new"]);
  });

  it("remembers the chosen sort", async () => {
    const ui = await boot();
    ui.choose("#sort", "newest");
    expect(localStorage.getItem("task-voice:sort")).toBe("newest");
  });
});

describe("preset filter", () => {
  it("filters by preset or default voice", async () => {
    const ui = await boot();
    const pid = ui.store.addPreset({ name: "Calm", voiceURI: "voice-a", rate: 0.8, pitch: 1 });
    ui.store.addText("with preset", pid);
    ui.store.addText("no preset");

    const labels = [...ui.$<HTMLSelectElement>("#filter-preset").options].map((o) => o.textContent);
    expect(labels).toEqual(["All presets", "Default voice", "Calm"]);

    ui.choose("#filter-preset", pid);
    expect(ui.texts()).toEqual(["with preset"]);
    ui.choose("#filter-preset", "default");
    expect(ui.texts()).toEqual(["no preset"]);
    ui.choose("#filter-preset", "all");
    expect(ui.texts()).toHaveLength(2);
  });

  it("falls back to All when the filtered preset is deleted", async () => {
    const ui = await boot();
    const pid = ui.store.addPreset({ name: "Gone", rate: 1, pitch: 1 });
    ui.store.addText("x", pid);
    ui.choose("#filter-preset", pid);
    ui.store.deletePreset(pid);
    expect(ui.$<HTMLSelectElement>("#filter-preset").value).toBe("all");
    expect(ui.texts()).toEqual(["x"]);
  });
});

describe("database status pill", () => {
  it("shows connected when the database is healthy", async () => {
    const ui = await boot();
    await vi.waitFor(() => expect(ui.$("#db-status").dataset.state).toBe("ok"));
    expect(ui.$("#db-status").textContent).toMatch(/database/i);
  });

  it("shows offline when Supabase can't be reached, and recovers on click", async () => {
    const ui = await boot();
    await vi.waitFor(() => expect(ui.$("#db-status").dataset.state).toBe("ok"));
    expect(ui.$("#db-status").title).toMatch(/Supabase/);

    fakeSupabase.offline = true;
    try {
      ui.$<HTMLButtonElement>("#db-status").click();
      await vi.waitFor(() => expect(ui.$("#db-status").dataset.state).toBe("offline"));
      expect(ui.$("#db-status").textContent).toMatch(/offline/i);
    } finally {
      fakeSupabase.offline = false;
    }
    ui.$<HTMLButtonElement>("#db-status").click();
    await vi.waitFor(() => expect(ui.$("#db-status").dataset.state).toBe("ok"));
  });
});

describe("bubble cards", () => {
  it("renders each text inside a speech bubble", async () => {
    const ui = await boot();
    ui.add("hello");
    expect(ui.$(".bubble .speech .text").textContent).toBe("hello");
  });
});
