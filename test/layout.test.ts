/**
 * Real-browser layout checks. jsdom doesn't do layout, so a chart can be "right" in the DOM
 * and still draw nothing. These tests render the dashboard here, then open that HTML with the
 * real stylesheet in a headless Chrome/Edge and measure the bars.
 * Skipped when no Chrome/Edge is found (set CHROME_PATH to point at one).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

function findBrowser(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}
const browser = findBrowser();

/** Open `bodyHtml` with the app's CSS in a headless browser; run `measure` there and return its JSON. */
function measureInBrowser(bodyHtml: string, measure: string): any {
  const css = readFileSync(join(process.cwd(), "src", "style.css"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "tv-layout-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(
      file,
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
       <style>body{width:1000px}</style></head>
       <body><div id="app">${bodyHtml}</div>
       <pre id="out"></pre>
       <script>document.getElementById("out").textContent = JSON.stringify((function(){ ${measure} })());</script>
       </body></html>`,
    );
    const dom = execFileSync(
      browser!,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        `--user-data-dir=${join(dir, "profile")}`,
        "--window-size=1100,1400",
        "--dump-dom",
        pathToFileURL(file).href,
      ],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const json = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
    if (!json) throw new Error("browser produced no measurement");
    return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Render the dashboard (jsdom) after playing texts; returns its HTML. */
async function renderedDashboard(plays: { text: string; times: number }[]): Promise<string> {
  await import("../src/main");
  const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  for (const p of plays) {
    $<HTMLTextAreaElement>("#new-text").value = p.text;
    $<HTMLFormElement>("#add-form").requestSubmit();
  }
  const { store } = await import("../src/store");
  for (const p of plays) {
    const id = store.texts.find((t) => t.text === p.text)!.id;
    for (let i = 0; i < p.times; i++) store.recordPlay(id, p.text.length, "voice-a");
  }
  const total = plays.reduce((s, p) => s + p.times, 0);
  $<HTMLButtonElement>('[data-tab="dashboard"]').click();
  await vi.waitFor(() => expect($('[data-stat="plays"]').textContent).toBe(String(total)));
  return document.getElementById("tab-dashboard")!.outerHTML;
}

const heights = (selector: string) => `
  const box = (el) => el.getBoundingClientRect().height;
  return [...document.querySelectorAll(${JSON.stringify(selector)})].map(box);`;

describe.skipIf(!browser)("dashboard charts really draw (headless browser)", () => {
  it("Plays per day shows today's bar at full height", async () => {
    const html = await renderedDashboard([{ text: "hello", times: 2 }]);
    const r = measureInBrowser(
      html,
      `const area = document.querySelector('[data-card="daily"] .cols').getBoundingClientRect().height;
       const bars = [...document.querySelectorAll('[data-card="daily"] .col')].map(b => b.getBoundingClientRect().height);
       return { area, today: bars[bars.length - 1], others: Math.max(...bars.slice(0, -1)), count: bars.length };`,
    );
    expect(r.count).toBe(30);
    expect(r.area).toBeGreaterThan(80);
    expect(r.today).toBeGreaterThan(r.area * 0.9); // the only day with plays = tallest bar
    expect(r.others).toBe(0);
  }, 90_000);

  it("Busiest hours draws a bar for the current hour", async () => {
    const html = await renderedDashboard([{ text: "hello", times: 1 }]);
    const r = measureInBrowser(html, heights('[data-card="hours"] .hour'));
    expect(r).toHaveLength(24);
    expect(Math.max(...r)).toBeGreaterThan(50);
    expect(r.filter((h: number) => h > 0)).toHaveLength(1);
  }, 90_000);

  it("bars scale with plays (half the plays = about half the height)", async () => {
    const html = await renderedDashboard([
      { text: "often", times: 4 },
      { text: "rarely", times: 2 },
    ]);
    const r = measureInBrowser(html, heights('[data-card="top"] .hbar'));
    expect(r).toHaveLength(2);
    const widths = measureInBrowser(
      html,
      `return [...document.querySelectorAll('[data-card="top"] .hbar')].map(b => b.getBoundingClientRect().width);`,
    );
    expect(widths[0]).toBeGreaterThan(0);
    expect(widths[1] / widths[0]).toBeCloseTo(0.5, 1);
  }, 90_000);
});
