import { describe, expect, it } from "vitest";
import { synth, voices, type FakeUtterance } from "./setup";

describe("Thai detection", () => {
  it("detects Thai characters", async () => {
    const { isThai } = await import("../src/tts");
    expect(isThai("สวัสดีครับ")).toBe(true);
    expect(isThai("Meeting at 3 โมง")).toBe(true);
    expect(isThai("hello world")).toBe(false);
    expect(isThai("")).toBe(false);
  });

  it("keeps the requested voice for non-Thai text", async () => {
    const { resolveVoice } = await import("../src/tts");
    expect(resolveVoice("hello", "voice-b")?.voiceURI).toBe("voice-b");
  });

  it("swaps a non-Thai voice for a Thai one when the text is Thai", async () => {
    const { resolveVoice } = await import("../src/tts");
    expect(resolveVoice("สวัสดี", "voice-a")?.voiceURI).toBe("voice-th");
    expect(resolveVoice("สวัสดี", "voice-th")?.voiceURI).toBe("voice-th");
  });

  it("returns no voice for Thai text when no Thai voice is installed", async () => {
    voices.splice(2, 1);
    const { resolveVoice } = await import("../src/tts");
    expect(resolveVoice("สวัสดี", "voice-a")).toBeUndefined();
  });
});

async function boot() {
  await import("../src/main");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const add = (text: string) => {
    $<HTMLTextAreaElement>("#new-text").value = text;
    $<HTMLFormElement>("#add-form").requestSubmit();
  };
  const lastUtterance = () => synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  return { $, add, lastUtterance };
}

function makePreset($: <T extends Element>(s: string) => T, voiceURI: string) {
  $<HTMLButtonElement>("#add-preset").click();
  const sel = [...document.querySelectorAll<HTMLSelectElement>('.preset [data-field="voiceURI"]')].at(-1)!;
  sel.value = voiceURI;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Thai in the app", () => {
  it("speaks Thai text with a Thai voice even if the default voice is English", async () => {
    const ui = await boot();
    ui.add("สวัสดีครับ");
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.lastUtterance().lang).toBe("th-TH");
  });

  it("previews Thai text with a Thai voice", async () => {
    const ui = await boot();
    ui.$<HTMLTextAreaElement>("#new-text").value = "ทดสอบ";
    ui.$<HTMLButtonElement>("#preview").click();
    expect(ui.lastUtterance().lang).toBe("th-TH");
  });

  it("only offers Thai-voice presets on a Thai bubble", async () => {
    const ui = await boot();
    makePreset(ui.$, "voice-a"); // Preset 1: English
    makePreset(ui.$, "voice-th"); // Preset 2: Thai
    ui.add("สวัสดี");
    ui.add("hello");
    const optionsFor = (text: string) => {
      const b = [...document.querySelectorAll(".bubble")].find((x) => x.querySelector(".text")!.textContent === text)!;
      return [...b.querySelectorAll<HTMLOptionElement>("[data-pick] option")].map((o) => o.textContent);
    };
    expect(optionsFor("สวัสดี")).toEqual(["Auto Thai voice (Microsoft Pattara)", "Preset 2"]);
    expect(optionsFor("hello")).toEqual(["Auto English voice (Voice A)", "Preset 1"]);
  });

  it("filters the add-form presets while typing Thai", async () => {
    const ui = await boot();
    makePreset(ui.$, "voice-a");
    makePreset(ui.$, "voice-th");
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "ภาษาไทย";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const opts = [...document.querySelectorAll<HTMLOptionElement>("#new-preset option")].map((o) => o.textContent);
    expect(opts).toEqual(["Auto Thai voice (Microsoft Pattara)", "Preset 2"]);
  });

  it("restores all presets in the add form after adding Thai text", async () => {
    const ui = await boot();
    makePreset(ui.$, "voice-a");
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "สวัสดี";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ui.$<HTMLFormElement>("#add-form").requestSubmit();
    const opts = [...document.querySelectorAll<HTMLOptionElement>("#new-preset option")].map((o) => o.textContent);
    expect(opts).toEqual(["Auto voice (matches your text)", "Preset 1"]); // empty box: all presets
  });

  it("warns when there is Thai text but no Thai voice installed", async () => {
    voices.splice(2, 1);
    const ui = await boot();
    expect(document.querySelector("#thai-warning")).toBeNull();
    ui.add("สวัสดี");
    expect(ui.$("#thai-warning").textContent).toMatch(/Thai voice/i);
  });

  it("marks Thai bubbles", async () => {
    const ui = await boot();
    ui.add("สวัสดี");
    ui.add("hello");
    expect(document.querySelectorAll(".bubble .lang-tag")).toHaveLength(1);
  });
});

describe("bubble layout", () => {
  it("puts Edit right next to the preset picker", async () => {
    const ui = await boot();
    ui.add("hello");
    const tools = ui.$(".bubble .bubble-tools");
    expect(tools.querySelector("[data-pick]")).not.toBeNull();
    expect(tools.querySelector('[data-act="edit"]')).not.toBeNull();
  });

  it("shows Save/Cancel in the same spot while editing", async () => {
    const ui = await boot();
    ui.add("hello");
    ui.$<HTMLButtonElement>('[data-act="edit"]').click();
    const tools = ui.$(".bubble .bubble-tools");
    expect(tools.querySelector('[data-act="save"]')).not.toBeNull();
    expect(tools.querySelector('[data-act="cancel"]')).not.toBeNull();
  });
});
