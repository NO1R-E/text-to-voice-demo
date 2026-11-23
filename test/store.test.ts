import { describe, expect, it, vi } from "vitest";
import { storeIdle } from "./setup";

const load = async () => {
  const { store } = await import("../src/store");
  await store.init();
  return store;
};
/** Simulate a page reload: fresh module, state loaded back from the database. */
const reload = async () => {
  await storeIdle();
  vi.resetModules();
  return load();
};

describe("store (Postgres-backed)", () => {
  it("saves, edits and deletes texts in the database", async () => {
    let store = await load();
    store.addText("hello");
    expect(store.texts.map((t) => t.text)).toEqual(["hello"]); // instant locally

    store = await reload();
    expect(store.texts.map((t) => t.text)).toEqual(["hello"]);

    store.updateText(store.texts[0].id, "hi there");
    store = await reload();
    expect(store.texts[0].text).toBe("hi there");

    store.deleteText(store.texts[0].id);
    store = await reload();
    expect(store.texts).toHaveLength(0);
  });

  it("saves play counts", async () => {
    let store = await load();
    store.addText("a");
    const id = store.texts[0].id;
    store.recordPlay(id, 1, "voice-a");
    store.recordPlay(id, 1, "voice-a");
    expect(store.playCount(id)).toBe(2);
    store = await reload();
    expect(store.playCount(id)).toBe(2);

    store.clearStats();
    expect(store.playCount(id)).toBe(0);
    store = await reload();
    expect(store.playCount(id)).toBe(0);
  });

  it("saves presets and their assignment; deleting a preset falls back to default", async () => {
    let store = await load();
    const pid = store.addPreset({ name: "Slow", rate: 0.5, pitch: 1 });
    store.addText("x", pid);
    store.updatePreset(pid, { rate: 0.8 });
    store.updatePreset(pid, { name: "Slower" });

    store = await reload();
    expect(store.texts[0].presetId).toBe(pid);
    expect(store.preset(pid)).toMatchObject({ name: "Slower", rate: 0.8 });

    store.deletePreset(pid);
    expect(store.texts[0].presetId).toBeUndefined();
    store = await reload();
    expect(store.presets).toHaveLength(0);
    expect(store.texts[0].presetId).toBeUndefined();
  });

  it("imports old browser (localStorage) data once", async () => {
    const tid = crypto.randomUUID();
    localStorage.setItem(
      "task-voice:v1",
      JSON.stringify({
        tasks: [{ id: tid, text: "from the browser", createdAt: Date.now() }],
        plays: [{ taskId: tid, at: Date.now(), chars: 16 }],
        presets: [],
      }),
    );
    let store = await load();
    expect(store.texts.map((t) => t.text)).toEqual(["from the browser"]);
    expect(store.playCount(tid)).toBe(1);

    store = await reload(); // second start must not import again
    expect(store.playCount(tid)).toBe(1);
  });

  it("reports an error when the API can't be reached", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    try {
      const store = await load();
      expect(store.error).toMatch(/database/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
