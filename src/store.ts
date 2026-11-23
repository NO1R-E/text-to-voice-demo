import * as db from "./backend";
import type { Account, Preset, Scope, TextItem } from "./backend";

export type { Account, Preset, Scope, StatsScope, TextItem } from "./backend";

const SCOPE_KEY = "task-voice:scope";
function savedScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "everyone" ? "everyone" : "mine";
  } catch {
    return "mine";
  }
}
let account: Account | null = null;
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

/** Re-read the account, texts (for the current scope) and presets. */
async function reload(): Promise<void> {
  account = await db.getAccount();
  const s = await db.loadState(store.scope);
  state.texts = s.texts;
  state.presets = s.presets;
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
  clearStats(): void {
    for (const t of state.texts) if (t.isMine) t.plays = 0; // resets plays of *your* texts
    notify();
    send(() => db.clearPlays());
  },
};

// Lets the test harness wait for in-flight saves between tests.
(globalThis as { __taskVoiceIdle?: () => Promise<void> }).__taskVoiceIdle = () => store.whenIdle();
