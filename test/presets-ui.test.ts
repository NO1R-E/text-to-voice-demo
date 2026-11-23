import { describe, expect, it } from "vitest";

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const card = (name: string) =>
    [...document.querySelectorAll<HTMLElement>(".preset")].find(
      (c) => c.querySelector(".preset-title")?.textContent === name || c.querySelector<HTMLInputElement>(".preset-name")?.value === name,
    )!;
  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  return { $, store, card, fire };
}

describe("preset cards", () => {
  it("existing presets show a compact summary, not the editor", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Calm", voiceURI: "voice-b", rate: 0.8, pitch: 1.2 });
    const c = ui.card("Calm");
    expect(c.querySelector("[data-field]")).toBeNull();
    expect(c.querySelector(".preset-summary")!.textContent).toMatch(/Voice B/);
    expect(c.querySelector(".preset-summary")!.textContent).toMatch(/0\.8×/);
    expect(c.querySelector(".preset-summary")!.textContent).toMatch(/pitch 1\.2/);
    expect(c.querySelector('[data-pact="edit"]')).not.toBeNull();
  });

  it("Edit opens the editor and Done closes it with the new values", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Calm", voiceURI: "voice-a", rate: 1, pitch: 1 });
    ui.card("Calm").querySelector<HTMLButtonElement>('[data-pact="edit"]')!.click();

    const c = ui.card("Calm");
    const rate = c.querySelector<HTMLInputElement>('[data-field="rate"]')!;
    rate.value = "1.5";
    ui.fire(rate, "input");
    c.querySelector<HTMLButtonElement>('[data-pact="done"]')!.click();

    const after = ui.card("Calm");
    expect(after.querySelector("[data-field]")).toBeNull();
    expect(after.querySelector(".preset-summary")!.textContent).toMatch(/1\.5×/);
  });

  it("only one preset is open for editing at a time", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "A", rate: 1, pitch: 1 });
    ui.store.addPreset({ name: "B", rate: 1, pitch: 1 });
    ui.card("A").querySelector<HTMLButtonElement>('[data-pact="edit"]')!.click();
    ui.card("B").querySelector<HTMLButtonElement>('[data-pact="edit"]')!.click();
    expect(document.querySelectorAll(".preset.editing")).toHaveLength(1);
    expect(ui.card("B").classList.contains("editing")).toBe(true);
  });

  it("a new preset opens straight in edit mode", async () => {
    const ui = await boot();
    ui.$<HTMLButtonElement>("#add-preset").click();
    expect(document.querySelectorAll(".preset.editing")).toHaveLength(1);
    expect(ui.$('.preset.editing [data-field="name"]')).not.toBeNull();
  });

  it("Test and Delete still work from the summary", async () => {
    const ui = await boot();
    ui.store.addPreset({ name: "Gone", rate: 1, pitch: 1 });
    ui.card("Gone").querySelector<HTMLButtonElement>('[data-pact="delete"]')!.click();
    expect(ui.store.presets).toHaveLength(0);
    expect(document.querySelectorAll(".preset")).toHaveLength(0);
  });

  it("shows how many texts use each preset", async () => {
    const ui = await boot();
    const pid = ui.store.addPreset({ name: "Used", rate: 1, pitch: 1 });
    ui.store.addText("a", pid);
    ui.store.addText("b", pid);
    expect(ui.card("Used").querySelector("[data-used]")!.textContent).toBe("2 texts");
  });
});
