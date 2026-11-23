import * as db from "./backend";
import type { Account, Preset, Scope, TextItem, VoiceDefaults } from "./backend";

export type { Account, Preset, Scope, StatsScope, TextItem, VoiceDefaults } from "./backend";

const SCOPE_KEY = "task-voice:scope";
function savedScope(): Scope {
  try {
    // Registered users see Everyone unless they chose Mine (guests always see Mine).
    return localStorage.getItem(SCOPE_KEY) === "mine" ? "mine" : "everyone";
  } catch {
    return "everyone";
  }
}
let account: Account | null = null;

// ---------- default voices (per account) ----------
const LEGACY_SETTINGS_KEY = "task-voice:settings"; // where older versions kept them, per browser
const standardDefaults = (): VoiceDefaults => ({ voices: {}, rate: 1, pitch: 1 });

/** Old per-browser defaults, if any (also migrates the oldest single `voiceURI` format). */
function legacyDefaults(): VoiceDefaults | null {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const voices: VoiceDefaults["voices"] = { ...(s.voices ?? {}) };
    // Oldest format: one voice, language unknown here. main.ts moves it to its real slot once voices load.
    if (typeof s.voiceURI === "string") voices.en ??= s.voiceURI;
    return { voices, rate: Number(s.rate) || 1, pitch: Number.isFinite(s.pitch) ? s.pitch : 1 };
  } catch {
    return null;
  }
}

/** One shared object (main.ts keeps a reference), refilled in place on account changes. */
const defaults: VoiceDefaults = standardDefaults();
let defaultsTimer: ReturnType<typeof setTimeout> | null = null;
let defaultsVersion = 0;

function flushDefaults(): void {
  if (defaultsTimer) clearTimeout(defaultsTimer);
  defaultsTimer = null;
  const userId = account?.userId;
  if (!userId) return;
  const snapshot = { voices: { th: defaults.voices.th, en: defaults.voices.en }, rate: defaults.rate, pitch: defaults.pitch };
  send(() => db.saveDefaults(userId, snapshot));
}
/** Which texts the list shows; "everyone" only applies to registered users. */
let scope: Scope = savedScope();

/**
 * Data lives in Supabase. The store keeps an in-memory copy so the UI updates
 * instantly, and sends each change to Supabase in order, one at a time.
 */
const state = { texts: [] as TextItem[], presets: [] as Preset[] };
const listeners = new Set<() => void>();
let lastError: string | null = null;
let queue: Promise<void> = Promise.resolve();
const presetTimers = new Map<string, ReturnType<typeof setTimeout>>();

const notify = () => listeners.forEach((fn) => fn());
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Save progress (for the status pill), kept separate from data listeners so it doesn't redraw the list.
let pending = 0;
const syncListeners = new Set<() => void>();
const notifySync = () => syncListeners.forEach((fn) => fn());

/** Queue one save; saves run strictly in order (a text is created before it's edited, etc.). */
function send(op: () => Promise<unknown>): void {
  pending++;
  notifySync();
  queue = queue.then(async () => {
    try {
      await op();
      if (lastError?.startsWith("Couldn't save")) {
        lastError = null; // a later save worked: clear the old failure
        notify();
      }
    } catch (e) {
      lastError = `Couldn't save to the database: ${message(e)}`;
      notify();
    } finally {
      pending--;
      notifySync();
    }
  });
}

/** Re-read the account, its default voices, texts (for the current scope) and presets. */
async function reload(): Promise<void> {
  account = await db.getAccount();
  const [s, saved] = await Promise.all([db.loadState(store.scope), db.getDefaults()]);
  state.texts = s.texts;
  state.presets = s.presets;

  // Account defaults win. A new account starts from this browser's old defaults
  // (once: they're saved to the account right away), else the standard ones.
  let next = saved;
  if (!next) {
    const legacy = legacyDefaults();
    if (legacy) {
      next = legacy;
      try {
        localStorage.removeItem(LEGACY_SETTINGS_KEY);
      } catch {
        /* ignore */
      }
    }
  }
  Object.assign(defaults, standardDefaults(), next ?? {});
  defaults.voices = { ...(next?.voices ?? {}) };
  defaultsVersion++;
  if (!saved && next) flushDefaults();
}

/** Run a reload, reporting (not throwing) connection problems. */
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    if (lastError?.startsWith("Can't reach")) lastError = null;
  } catch (e) {
    lastError = `Can't reach the database (Supabase): ${message(e)}`;
  }
  notify();
}

function sendPreset(id: string): void {
  const p = state.presets.find((x) => x.id === id);
  if (p) send(() => db.updatePreset({ ...p }));
}

export const store = {
  get texts(): readonly TextItem[] {
    return state.texts;
  },
  get presets(): readonly Preset[] {
    return state.presets;
  },
  /** Last load/save problem, shown to the user; null when all is well. */
  get error(): string | null {
    return lastError;
  },
  subscribe(fn: () => void): void {
    listeners.add(fn);
  },
  /** Number of changes not yet saved to the database. */
  get pendingSaves(): number {
    return pending;
  },
  /** Called whenever pendingSaves changes. */
  onSync(fn: () => void): void {
    syncListeners.add(fn);
  },

  /** Sign this browser in (anonymously, once) and load its texts + presets. */
  async init(): Promise<void> {
    try {
      await db.ensureSession();
      await reload();
      lastError = null;
    } catch (e) {
      lastError = `Can't reach the database (Supabase): ${message(e)}`;
    }
    notify();
  },

  // ---- default voices (per account) ----
  /** The account's default voices. Same object for the app's lifetime; refilled on sign in/out. */
  get defaults(): VoiceDefaults {
    return defaults;
  },
  /** Bumps whenever defaults are replaced by another account's (so the UI can redraw its controls). */
  get defaultsVersion(): number {
    return defaultsVersion;
  },
  /** Change defaults locally at once; saved to the account shortly after (sliders fire a lot). */
  updateDefaults(patch: Partial<Omit<VoiceDefaults, "voices">> & { voices?: VoiceDefaults["voices"] }): void {
    if (patch.voices) defaults.voices = { ...defaults.voices, ...patch.voices };
    if (patch.rate !== undefined) defaults.rate = patch.rate;
    if (patch.pitch !== undefined) defaults.pitch = patch.pitch;
    if (defaultsTimer) clearTimeout(defaultsTimer);
    defaultsTimer = setTimeout(flushDefaults, 300);
  },

  // ---- account ----
  get account(): Account | null {
    return account;
  },
  get registered(): boolean {
    return !!account && !account.anonymous;
  },
  /** The list's current view ("everyone" only for registered users). */
  get scope(): Scope {
    return store.registered ? scope : "mine";
  },
  async setScope(next: Scope): Promise<void> {
    scope = next;
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* ignore */
    }
    await store.whenIdle();
    await guarded(reload);
  },
  /** Upgrade this anonymous visitor to a registered user (keeps their texts). */
  async signUp(displayName: string, email: string, password: string): Promise<"done" | "confirm"> {
    await store.whenIdle();
    const result = await db.signUp(displayName, email, password);
    await guarded(reload);
    return result;
  },
  async signIn(email: string, password: string): Promise<void> {
    await store.whenIdle();
    await db.signIn(email, password);
    await guarded(reload);
  },
  async signOut(): Promise<void> {
    await store.whenIdle();
    await db.signOut();
    await guarded(reload);
  },

  /** Resolves once every pending change has been saved. */
  async whenIdle(): Promise<void> {
    if (defaultsTimer) flushDefaults();
    for (const id of [...presetTimers.keys()]) {
      clearTimeout(presetTimers.get(id));
      presetTimers.delete(id);
      sendPreset(id);
    }
    let q: Promise<void>;
    do {
      q = queue;
      await q;
    } while (q !== queue);
  },

  // ---- texts ----
  addText(text: string, presetId?: string): void {
    const t: TextItem = {
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now(),
      presetId,
      plays: 0,
      isMine: true,
      author: account?.displayName,
    };
    state.texts.unshift(t);
    notify();
    send(() => db.insertText(t));
  },
  updateText(id: string, text: string): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.text = text;
    notify();
    send(() => db.updateText(id, { text }));
  },
  setTextPreset(id: string, presetId: string | undefined): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.presetId = presetId;
    notify();
    send(() => db.updateText(id, { presetId: presetId ?? null }));
  },
  deleteText(id: string): void {
    state.texts = state.texts.filter((t) => t.id !== id);
    notify();
    send(() => db.deleteText(id));
  },

  // ---- presets ----
  preset(id: string | undefined): Preset | undefined {
    return id ? state.presets.find((p) => p.id === id) : undefined;
  },
  addPreset(p: Omit<Preset, "id">): string {
    const preset: Preset = { id: crypto.randomUUID(), ...p };
    state.presets.push(preset);
    notify();
    send(() => db.insertPreset({ ...preset }));
    return preset.id;
  },
  /** Local update is instant; the save is debounced (sliders fire many events). */
  updatePreset(id: string, patch: Partial<Omit<Preset, "id">>): void {
    const p = state.presets.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    notify();
    clearTimeout(presetTimers.get(id));
    presetTimers.set(
      id,
      setTimeout(() => {
        presetTimers.delete(id);
        sendPreset(id);
      }, 300),
    );
  },
  deletePreset(id: string): void {
    clearTimeout(presetTimers.get(id));
    presetTimers.delete(id);
    state.presets = state.presets.filter((p) => p.id !== id);
    for (const t of state.texts) if (t.presetId === id) t.presetId = undefined;
    notify();
    send(() => db.deletePreset(id));
  },

  // ---- plays (dashboard data) ----
  recordPlay(id: string, chars: number, voiceURI?: string, presetId?: string): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.plays++;
    notify();
    send(() => db.insertPlay(id, chars, voiceURI, presetId));
  },
  playCount(id: string): number {
    return state.texts.find((t) => t.id === id)?.plays ?? 0;
  },
};

// Lets the test harness wait for in-flight saves between tests.
(globalThis as { __taskVoiceIdle?: () => Promise<void> }).__taskVoiceIdle = () => store.whenIdle();
