import { describe, expect, it } from "vitest";

const LONG = "a" + "h".repeat(400);

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const bubbleFor = (prefix: string) =>
    [...document.querySelectorAll<HTMLElement>(".bubble")].find((b) =>
      b.querySelector(".text")?.textContent?.startsWith(prefix),
    )!;
  return { $, store, bubbleFor };
}

describe("long texts in bubbles", () => {
  it("clamps a long text and offers Show more", async () => {
    const ui = await boot();
    ui.store.addText(LONG);
    const b = ui.bubbleFor("ah");
    expect(b.querySelector(".text")!.classList.contains("clamped")).toBe(true);
    expect(b.querySelector('[data-act="more"]')!.textContent).toMatch(/Show more/);
  });

  it("expands and collapses, and stays expanded across re-renders", async () => {
    const ui = await boot();
    ui.store.addText(LONG);
    ui.bubbleFor("ah").querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
    expect(ui.bubbleFor("ah").querySelector(".text")!.classList.contains("clamped")).toBe(false);
    expect(ui.bubbleFor("ah").querySelector('[data-act="more"]')!.textContent).toMatch(/Show less/);

    ui.store.addText("another"); // triggers a re-render
    expect(ui.bubbleFor("ah").querySelector(".text")!.classList.contains("clamped")).toBe(false);

    ui.bubbleFor("ah").querySelector<HTMLButtonElement>('[data-act="more"]')!.click();
    expect(ui.bubbleFor("ah").querySelector(".text")!.classList.contains("clamped")).toBe(true);
  });

  it("treats many short lines as long too", async () => {
    const ui = await boot();
    ui.store.addText("one\ntwo\nthree\nfour\nfive\nsix");
    expect(ui.bubbleFor("one").querySelector('[data-act="more"]')).not.toBeNull();
  });

  it("leaves short texts alone", async () => {
    const ui = await boot();
    ui.store.addText("Howdy");
    const b = ui.bubbleFor("Howdy");
    expect(b.querySelector(".text")!.classList.contains("clamped")).toBe(false);
    expect(b.querySelector('[data-act="more"]')).toBeNull();
    expect(b.querySelector(".speech")!.classList.contains("long")).toBe(false);
  });
});

describe("length limit", () => {
  it("limits the add box and shows a live counter", async () => {
    const ui = await boot();
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    expect(ta.maxLength).toBe(1000);
    expect(ui.$("#char-count").textContent).toBe("0 / 1000");
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ui.$("#char-count").textContent).toBe("5 / 1000");
  });

  it("warns near the limit and resets after adding", async () => {
    const ui = await boot();
    const ta = ui.$<HTMLTextAreaElement>("#new-text");
    ta.value = "x".repeat(950);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ui.$("#char-count").classList.contains("near")).toBe(true);
    ui.$<HTMLFormElement>("#add-form").requestSubmit();
    expect(ui.$("#char-count").textContent).toBe("0 / 1000");
    expect(ui.$("#char-count").classList.contains("near")).toBe(false);
  });

  it("limits the edit box too", async () => {
    const ui = await boot();
    ui.store.addText("Howdy");
    ui.$<HTMLButtonElement>('[data-act="edit"]').click();
    expect(ui.$<HTMLTextAreaElement>("textarea.edit").maxLength).toBe(1000);
  });
});
