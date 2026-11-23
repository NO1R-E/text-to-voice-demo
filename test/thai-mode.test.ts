import { describe, expect, it } from "vitest";
import { synth, type FakeUtterance } from "./setup";

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const makePreset = (voiceURI: string, rate: number) => {
    $<HTMLButtonElement>("#add-preset").click();
    const card = [...document.querySelectorAll(".preset")].at(-1)!;
    const voice = card.querySelector<HTMLSelectElement>('[data-field="voiceURI"]')!;
    voice.value = voiceURI;
    fire(voice, "input");
    const r = card.querySelector<HTMLInputElement>('[data-field="rate"]')!;
    r.value = String(rate);
    fire(r, "input");
    return store.presets.at(-1)!.id;
  };
  const optionLabels = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);
  const lastUtterance = () => synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  return { $, fire, store, makePreset, optionLabels, lastUtterance };
}

describe("Thai mode — add form", () => {
  it("switches to Thai mode immediately when Thai is typed, dropping an English preset", async () => {
    const ui = await boot();
    const eng = ui.makePreset("voice-a", 1.5); // English voice
    ui.makePreset("voice-th", 1); // Thai voice
    const sel = ui.$<HTMLSelectElement>("#new-preset");
    sel.value = eng;

    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "ส";
    ui.fire(ta, "input");

    expect(sel.value).toBe(""); // English preset no longer selected
    expect(ui.optionLabels(sel)).toEqual(["Auto Thai voice (Microsoft Pattara)", "Preset 2"]);
    expect(ui.$("#add-form").classList.contains("thai-mode")).toBe(true);
  });

  it("saves Thai text without the English preset", async () => {
    const ui = await boot();
    const eng = ui.makePreset("voice-a", 1.5);
    ui.$<HTMLSelectElement>("#new-preset").value = eng;
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "สวัสดี";
    ui.fire(ta, "input");
    ui.$<HTMLFormElement>("#add-form").requestSubmit();
    expect(ui.store.texts[0].presetId).toBeUndefined();
  });

  it("can still pick a Thai preset for Thai text", async () => {
    const ui = await boot();
    const th = ui.makePreset("voice-th", 0.7);
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "สวัสดี";
    ui.fire(ta, "input");
    ui.$<HTMLSelectElement>("#new-preset").value = th;
    ui.$<HTMLFormElement>("#add-form").requestSubmit();
    expect(ui.store.texts[0].presetId).toBe(th);
  });
});

describe("Thai mode — bubbles", () => {
  it("never shows an English preset as selected on a Thai bubble, and doesn't use its settings", async () => {
    const ui = await boot();
    const eng = ui.makePreset("voice-a", 1.5);
    ui.store.addText("สวัสดี", eng); // e.g. data saved before this change
    const pick = ui.$<HTMLSelectElement>(".bubble [data-pick]");
    expect(pick.value).toBe("");
    expect(ui.optionLabels(pick)).toEqual(["Auto Thai voice (Microsoft Pattara)"]);

    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.lastUtterance().lang).toBe("th-TH");
    expect(ui.lastUtterance().rate).toBe(1); // default rate, not the English preset's 1.5
  });

  it("switches the bubble's picker to Thai mode while editing, then clears the English preset on save", async () => {
    const ui = await boot();
    const eng = ui.makePreset("voice-a", 1.5);
    ui.store.addText("hello", eng);

    ui.$<HTMLButtonElement>('[data-act="edit"]').click();
    const ta = ui.$<HTMLTextAreaElement>("textarea.edit");
    ta.value = "สวัสดี";
    ui.fire(ta, "input");
    const pick = ui.$<HTMLSelectElement>(".bubble [data-pick]");
    expect(pick.value).toBe("");
    expect(ui.optionLabels(pick)).toEqual(["Auto Thai voice (Microsoft Pattara)"]);

    ui.$<HTMLButtonElement>('[data-act="save"]').click();
    expect(ui.store.texts[0].presetId).toBeUndefined();
  });

  it("keeps a Thai preset when the text is Thai", async () => {
    const ui = await boot();
    const th = ui.makePreset("voice-th", 0.7);
    ui.store.addText("สวัสดี", th);
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.$<HTMLSelectElement>(".bubble [data-pick]").value).toBe(th);
    expect(ui.lastUtterance().rate).toBe(0.7);
  });
});
