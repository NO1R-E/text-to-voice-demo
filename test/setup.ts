import { afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { testDatabaseUrl } from "./db-url";

// ---------- "Supabase" = local *_test database + fake client (see fake-supabase.ts) ----------
export const testPool = new pg.Pool({ connectionString: testDatabaseUrl() });
export const fakeSupabase = { pool: testPool, offline: false };
(globalThis as any).__fakeSupabase = fakeSupabase;

/** Wait for whatever the current store instance still has in flight. */
export const storeIdle = async () => {
  await (globalThis as any).__taskVoiceIdle?.();
};

// ---------- fake speech synthesis (jsdom has none) ----------
export class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

export const voices = [
  { voiceURI: "voice-a", name: "Voice A", lang: "en-US", default: true },
  { voiceURI: "voice-b", name: "Voice B", lang: "en-GB", default: false },
  { voiceURI: "voice-th", name: "Microsoft Pattara", lang: "th-TH", default: false },
  { voiceURI: "voice-ja", name: "Microsoft Haruka", lang: "ja-JP", default: false }, // unsupported: must be hidden
];
const allVoices = [...voices];

export const synth = {
  speak: vi.fn(),
  cancel: vi.fn(),
  getVoices: vi.fn(() => voices),
  addEventListener: vi.fn(),
};

const browser = typeof window !== "undefined";
if (browser) {
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(globalThis, "speechSynthesis", { value: synth, configurable: true });
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
}

beforeEach(async () => {
  await storeIdle(); // let the previous test's saves land before wiping
  fakeSupabase.offline = false;
  await testPool.query("truncate public.plays, public.texts, public.presets, auth.users restart identity cascade");
  voices.splice(0, voices.length, ...allVoices);
  synth.speak.mockClear();
  synth.cancel.mockClear();
  if (browser) {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML = `<div id="app"></div>`;
  }
  vi.resetModules(); // each test gets a fresh store + fresh app
});

afterAll(async () => {
  await storeIdle();
  await testPool.end();
});
