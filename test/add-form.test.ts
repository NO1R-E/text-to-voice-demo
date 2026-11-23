import { describe, expect, it } from "vitest";
import { synth, type FakeUtterance } from "./setup";

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const sel = () => $<HTMLSelectElement>("#new-preset");
  const labels = () => [...sel().options].map((o) => o.textContent);
  const groups = () => [...sel().querySelectorAll("optgroup")].map((g) => g.label);
  const type = (v: string) => {
    const ta = $<HTMLTextAreaElement>("#new-text");
    ta.value = v;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const lastUtterance = () => synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  const spoken = () => synth.speak.mock.calls.map(([u]) => (u as FakeUtterance).text).join("");
  return { $, store, sel, labels, groups, type, lastUtterance, spoken };
}

describe("add form preset picker", () => {
  it("lists every preset, grouped by language, while the box is empty", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Thai P", voiceURI: "voice-th", rate: 1, pitch: 1 });
    ui.store.addPreset({ name: "Eng P", voiceURI: "voice-b", rate: 1, pitch: 1 });
    expect(ui.labels()).toEqual(["Auto voice (matches your text)", "Thai P", "Eng P"]);
    expect(ui.groups()).toEqual(["ไทย · Thai", "English"]);
  });

  it("lets you pick a Thai preset first, then type Thai, and saves it", async () => {
    const ui = await boot();
    const th = ui.store.addPreset({ name: "Thai P", voiceURI: "voice-th", rate: 1, pitch: 1 });
    ui.sel().value = th;
    ui.type("สวัสดี");
    expect(ui.sel().value).toBe(th); // still selected in Thai mode
    ui.$<HTMLFormElement>("#add-form").requestSubmit();
    expect(ui.store.texts[0].presetId).toBe(th);
  });

  it("narrows to the typed language and widens again when cleared", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Thai P", voiceURI: "voice-th", rate: 1, pitch: 1 });
    ui.store.addPreset({ name: "Eng P", voiceURI: "voice-b", rate: 1, pitch: 1 });
    ui.type("hello");
    expect(ui.labels()).toEqual(["Auto English voice (Voice A)", "Eng P"]);
    ui.type("");
    expect(ui.labels()).toEqual(["Auto voice (matches your text)", "Thai P", "Eng P"]);
  });
});

describe("default voice preview", () => {
  it("previews the default Thai voice with a Thai sample", async () => {
    const ui = await boot();
    ui.$<HTMLButtonElement>('[data-preview-lang="th"]').click();
    expect(ui.lastUtterance().lang).toBe("th-TH");
    expect(ui.spoken()).toMatch(/[฀-๿]/);
  });

  it("previews the chosen default English voice with the default speed", async () => {
    const ui = await boot();
    const en = ui.$<HTMLSelectElement>("#voice-en");
    en.value = "voice-b";
    en.dispatchEvent(new Event("change", { bubbles: true }));
    const rate = ui.$<HTMLInputElement>("#rate");
    rate.value = "1.4";
    rate.dispatchEvent(new Event("input", { bubbles: true }));

    ui.$<HTMLButtonElement>('[data-preview-lang="en"]').click();
    expect(ui.lastUtterance().lang).toBe("en-GB");
    expect(ui.lastUtterance().rate).toBe(1.4);
  });

  it("a second click stops the preview", async () => {
    const ui = await boot();
    const btn = ui.$<HTMLButtonElement>('[data-preview-lang="en"]');
    btn.click();
    const cancels = synth.cancel.mock.calls.length;
    btn.click();
    expect(synth.speak.mock.calls).toHaveLength(1);
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancels);
  });
});
