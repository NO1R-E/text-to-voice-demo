import { describe, expect, it, vi } from "vitest";
import { fakeSupabase, storeIdle, testPool } from "./setup";

const load = async () => {
  const { store } = await import("../src/store");
  await store.init();
  return store;
};
/** Simulate a page reload: fresh module, same browser session, state loaded back from Supabase. */
const reload = async () => {
  await storeIdle();
  vi.resetModules();
  return load();
};

describe("store (Supabase-backed)", () => {
  it("signs the visitor in anonymously on first load", async () => {
    await load();
    const { rows } = await testPool.query("select is_anonymous from auth.users");
    expect(rows).toEqual([{ is_anonymous: true }]);
  });

  it("keeps the same anonymous visitor across reloads", async () => {
    await load();
    await reload();
    const { rowCount } = await testPool.query("select 1 from auth.users");
    expect(rowCount).toBe(1);
  });

  it("saves, edits and deletes texts", async () => {
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

  it("saves play counts and clears them", async () => {
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

  it("saves presets and their assignment; deleting a preset falls back to Auto", async () => {
    let store = await load();
    const pid = store.addPreset({ name: "Slow", voiceURI: "voice-a", rate: 0.5, pitch: 1 });
    store.addText("x", pid);
    store.updatePreset(pid, { rate: 0.8 });
    store.updatePreset(pid, { name: "Slower" });

    store = await reload();
    expect(store.texts[0].presetId).toBe(pid);
    expect(store.preset(pid)).toMatchObject({ name: "Slower", voiceURI: "voice-a", rate: 0.8 });

    store.deletePreset(pid);
    expect(store.texts[0].presetId).toBeUndefined();
    store = await reload();
    expect(store.presets).toHaveLength(0);
    expect(store.texts[0].presetId).toBeUndefined();
  });

  it("reports an error when Supabase can't be reached", async () => {
    fakeSupabase.offline = true;
    const store = await load();
    expect(store.error).toMatch(/database/i);
  });

  it("reports a failed save", async () => {
    const store = await load();
    fakeSupabase.offline = true;
    store.addText("lost");
    await store.whenIdle();
    expect(store.error).toMatch(/Couldn't save/);
  });
});
