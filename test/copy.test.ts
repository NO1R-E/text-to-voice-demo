import { describe, expect, it, vi } from "vitest";

function mockClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(writeText) }, configurable: true });
  return (navigator.clipboard.writeText as ReturnType<typeof vi.fn>);
}

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  return { $, store };
}

describe("copy text", () => {
  it("each bubble has a copy button", async () => {
    const ui = await boot();
    ui.store.addText("one");
    ui.store.addText("two");
    expect(document.querySelectorAll('.bubble [data-act="copy"]')).toHaveLength(2);
    expect(ui.$('[data-act="copy"]').getAttribute("aria-label")).toBe("Copy text");
  });

  it("copies the full text, even when the bubble is clamped", async () => {
    const write = mockClipboard(() => Promise.resolve());
    const ui = await boot();
    const long = "word ".repeat(100).trim();
    ui.store.addText(long);
    ui.$<HTMLButtonElement>('[data-act="copy"]').click();
    expect(write).toHaveBeenCalledWith(long);
    await vi.waitFor(() => expect(ui.$('[data-act="copy"]').getAttribute("data-state")).toBe("copied"));
    expect(ui.$('[data-act="copy"]').getAttribute("aria-label")).toBe("Copied!");
  });

  it("says so when copying fails", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    const ui = await boot();
    ui.store.addText("x");
    ui.$<HTMLButtonElement>('[data-act="copy"]').click();
    await vi.waitFor(() => expect(ui.$('[data-act="copy"]').getAttribute("data-state")).toBe("failed"));
  });

  it("does not count as a play", async () => {
    mockClipboard(() => Promise.resolve());
    const ui = await boot();
    ui.store.addText("x");
    ui.$<HTMLButtonElement>('[data-act="copy"]').click();
    expect(ui.store.texts[0].plays).toBe(0);
  });
});
