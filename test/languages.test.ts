import { describe, expect, it } from "vitest";
import { synth, type FakeUtterance } from "./setup";

describe("language helpers", () => {
  it("classifies text as Thai or English", async () => {
    const { languageOf } = await import("../src/tts");
    expect(languageOf("hello")).toBe("en");
    expect(languageOf("สวัสดี")).toBe("th");
    expect(languageOf("Meeting 3 โมง")).toBe("th"); // any Thai → Thai
    expect(languageOf("123")).toBe("en");
  });

  it("only Thai and English voices are supported", async () => {
    const { voiceLanguage, supportedVoices } = await import("../src/tts");
    expect(voiceLanguage({ lang: "th-TH" })).toBe("th");
    expect(voiceLanguage({ lang: "en-GB" })).toBe("en");
    expect(voiceLanguage({ lang: "en_US" })).toBe("en");
    expect(voiceLanguage({ lang: "ja-JP" })).toBeNull();
    expect(supportedVoices().map((v) => v.voiceURI)).toEqual(["voice-a", "voice-b", "voice-th"]);
  });

  it("English text never gets a Thai voice", async () => {
    const { resolveVoice } = await import("../src/tts");
    expect(resolveVoice("hello", "voice-th")?.voiceURI).toBe("voice-a");
    expect(resolveVoice("hello", "voice-ja")?.voiceURI).toBe("voice-a");
    expect(resolveVoice("hello", "voice-b")?.voiceURI).toBe("voice-b");
  });
});

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const labels = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);
  const groups = (sel: HTMLSelectElement) => [...sel.querySelectorAll("optgroup")].map((g) => g.label);
  const lastUtterance = () => synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  return { $, store, labels, groups, lastUtterance };
}

describe("voice pickers", () => {
  it("has one default voice per language, each listing only that language", async () => {
    const ui = await boot();
    expect(ui.labels(ui.$("#voice-th"))).toEqual(["Microsoft Pattara (th-TH)"]);
    expect(ui.labels(ui.$("#voice-en"))).toEqual(["Voice A (en-US)", "Voice B (en-GB)"]);
  });

  it("groups preset voices by language and hides other languages", async () => {
    const ui = await boot();
    ui.$<HTMLButtonElement>("#add-preset").click();
    const sel = ui.$<HTMLSelectElement>('.preset.editing [data-field="voiceURI"]');
    expect(ui.groups(sel)).toEqual(["ไทย · Thai", "English"]);
    expect(ui.labels(sel)).not.toContain("Microsoft Haruka (ja-JP)");
  });

  it("uses the chosen default English voice for English text", async () => {
    const ui = await boot();
    const en = ui.$<HTMLSelectElement>("#voice-en");
    en.value = "voice-b";
    en.dispatchEvent(new Event("change", { bubbles: true }));
    ui.store.addText("hello");
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.lastUtterance().lang).toBe("en-GB");
  });

  it("migrates the old single default voice into its language slot", async () => {
    localStorage.setItem("task-voice:settings", JSON.stringify({ voiceURI: "voice-b", rate: 1.2, pitch: 1 }));
    const ui = await boot();
    expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-b");
  });
});

describe("English mode (mirror of Thai mode)", () => {
  it("English text with a Thai preset uses the auto English voice and default settings", async () => {
    const ui = await boot();
    const th = ui.store.addPreset({ name: "TH", voiceURI: "voice-th", rate: 0.6, pitch: 1 });
    ui.store.addText("hello", th);
    const pick = ui.$<HTMLSelectElement>(".bubble [data-pick]");
    expect(pick.value).toBe("");
    expect(ui.labels(pick)).toEqual(["Auto English voice (Voice A)"]);
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.lastUtterance().lang).toBe("en-US");
    expect(ui.lastUtterance().rate).toBe(1);
  });
});

describe("presets grouped by language", () => {
  it("puts each preset under its voice's language", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Thai one", voiceURI: "voice-th", rate: 1, pitch: 1 });
    ui.store.addPreset({ name: "English one", voiceURI: "voice-b", rate: 1, pitch: 1 });
    const inGroup = (lang: string) =>
      [...document.querySelectorAll(`.preset-group[data-lang="${lang}"] .preset-title`)].map((e) => e.textContent);
    expect(inGroup("th")).toEqual(["Thai one"]);
    expect(inGroup("en")).toEqual(["English one"]);
  });

  it("flags a preset whose voice isn't Thai or English", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Old", voiceURI: "voice-ja", rate: 1, pitch: 1 });
    expect(document.querySelector('.preset-group[data-lang="other"] .preset-title')!.textContent).toBe("Old");
  });
});
