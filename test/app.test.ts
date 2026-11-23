import { describe, expect, it } from "vitest";
import { synth, type FakeUtterance } from "./setup";

async function boot() {
  await import("../src/main");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  return {
    $,
    texts: () => [...document.querySelectorAll(".bubble .text")].map((e) => e.textContent),
    spoken: () => synth.speak.mock.calls.map(([u]) => (u as FakeUtterance).text).join(""),
    type: (v: string) => ($<HTMLTextAreaElement>("#new-text").value = v),
    submit: () => $<HTMLFormElement>("#add-form").requestSubmit(),
  };
}

describe("app", () => {
  it("starts without throwing", async () => {
    await expect(import("../src/main")).resolves.toBeDefined();
  });

  it("adds a text from the form", async () => {
    const ui = await boot();
    ui.type("Buy milk");
    ui.submit();
    expect(ui.texts()).toEqual(["Buy milk"]);
    expect(ui.$<HTMLTextAreaElement>("#new-text").value).toBe("");
  });

  it("adds a text on Enter", async () => {
    const ui = await boot();
    ui.type("Press enter");
    ui.$("#new-text").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ui.texts()).toEqual(["Press enter"]);
  });

  it("previews the typed text out loud", async () => {
    const ui = await boot();
    ui.type("Preview me");
    ui.$<HTMLButtonElement>("#preview").click();
    expect(ui.spoken()).toBe("Preview me");
  });

  it("speaks a bubble and counts the play", async () => {
    const ui = await boot();
    ui.type("Say this");
    ui.submit();
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.spoken()).toBe("Say this");
    expect(ui.$(".bubble .meta").textContent).toBe("1 play");
  });

  it("sorts bubbles by most played", async () => {
    const ui = await boot();
    ui.type("first");
    ui.submit();
    ui.type("second");
    ui.submit();
    expect(ui.texts()).toEqual(["second", "first"]); // newest first when tied
    const firstBubble = [...document.querySelectorAll<HTMLElement>(".bubble")].find(
      (b) => b.querySelector(".text")!.textContent === "first",
    )!;
    firstBubble.querySelector<HTMLButtonElement>('[data-act="speak"]')!.click();
    expect(ui.texts()).toEqual(["first", "second"]);
  });

  it("reads a bubble with its assigned preset", async () => {
    const ui = await boot();
    ui.$<HTMLButtonElement>("#add-preset").click();
    const rate = ui.$<HTMLInputElement>('.preset [data-field="rate"]');
    rate.value = "1.7";
    rate.dispatchEvent(new Event("input", { bubbles: true }));

    ui.type("Fast one");
    ui.submit();
    const pick = ui.$<HTMLSelectElement>(".bubble [data-pick]");
    pick.selectedIndex = 1;
    pick.dispatchEvent(new Event("change", { bubbles: true }));

    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    const u = synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
    expect(u.rate).toBe(1.7);
  });
});
