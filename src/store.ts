import { api } from "./api";

export interface TextItem {
  id: string;
  text: string;
  createdAt: number;
  /** Voice preset used to read this text; undefined = default settings. */
  presetId?: string;
  /** Times read aloud (all time). */
  plays: number;
}

/** A saved, named set of voice settings that texts can be assigned to. */
export interface Preset {
  id: string;
  name: string;
  voiceURI?: string;
  rate: number;
  pitch: number;
}

/**
 * Data lives in Postgres (via the local API). The store keeps an in-memory copy so
 * the UI updates instantly, and sends each change to the API in order, one at a time.
 */
const state = { texts: [] as TextItem[], presets: [] as Preset[] };
const listeners = new Set<() => void>();
let lastError: string | null = null;
let queue: Promise<void> = Promise.resolve();
const presetTimers = new Map<string, ReturnType<typeof setTimeout>>();

const LEGACY_KEY = "task-voice:v1"; // pre-database localStorage data
const MIGRATED_KEY = "task-voice:migrated-to-db";

const notify = () => listeners.forEach((fn) => fn());
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Save progress (for the status pill), kept separate from data listeners so it doesn't redraw the list.
let pending = 0;
const syncListeners = new Set<() => void>();
const notifySync = () => syncListeners.forEach((fn) => fn());

function send(method: string, path: string, body?: unknown): void {
  pending++;
  notifySync();
  queue = queue.then(async () => {
    try {
      await api(method, path, body);
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

function sendPreset(id: string): void {
  const p = state.presets.find((x) => x.id === id);
  if (p) send("PATCH", `/presets/${id}`, { name: p.name, voiceURI: p.voiceURI ?? null, rate: p.rate, pitch: p.pitch });
}

/** Copy the old browser-only data into the database, once per browser. */
async function importLegacy(): Promise<void> {
  let raw: string | null;
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return; // storage unavailable
  }
  if (raw) {
    let data: { tasks?: unknown[]; presets?: unknown[]; plays?: unknown[] } | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* corrupt: nothing to import */
    }
    if (data) {
      await api("POST", "/import", { presets: data.presets ?? [], texts: data.tasks ?? [], plays: data.plays ?? [] });
    }
  }
  try {
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString()); // old data is kept as a backup
  } catch {
    /* ignore */
  }
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

  /** Load everything from the database (importing old browser data first, once). */
  async init(): Promise<void> {
    try {
      await importLegacy();
      const s = await api<{ texts: TextItem[]; presets: Preset[] }>("GET", "/state");
      state.texts = s.texts;
      state.presets = s.presets;
      lastError = null;
    } catch (e) {
      lastError = `Can't reach the database API (${message(e)}). Start it with "npm run dev".`;
    }
    notify();
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
    const t: TextItem = { id: crypto.randomUUID(), text, createdAt: Date.now(), presetId, plays: 0 };
    state.texts.unshift(t);
    notify();
    send("POST", "/texts", { id: t.id, text, presetId: presetId ?? null });
  },
  updateText(id: string, text: string): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.text = text;
    notify();
    send("PATCH", `/texts/${id}`, { text });
  },
  setTextPreset(id: string, presetId: string | undefined): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.presetId = presetId;
    notify();
    send("PATCH", `/texts/${id}`, { presetId: presetId ?? null });
  },
  deleteText(id: string): void {
    state.texts = state.texts.filter((t) => t.id !== id);
    notify();
    send("DELETE", `/texts/${id}`);
  },

  // ---- presets ----
  preset(id: string | undefined): Preset | undefined {
    return id ? state.presets.find((p) => p.id === id) : undefined;
  },
  addPreset(p: Omit<Preset, "id">): string {
    const id = crypto.randomUUID();
    state.presets.push({ id, ...p });
    notify();
    send("POST", "/presets", { id, ...p, voiceURI: p.voiceURI ?? null });
    return id;
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
    send("DELETE", `/presets/${id}`);
  },

  // ---- plays (dashboard data) ----
  recordPlay(id: string, chars: number, voiceURI?: string, presetId?: string): void {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    t.plays++;
    notify();
    send("POST", `/texts/${id}/plays`, { chars, voiceURI: voiceURI ?? null, presetId: presetId ?? null });
  },
  playCount(id: string): number {
    return state.texts.find((t) => t.id === id)?.plays ?? 0;
  },
  clearStats(): void {
    for (const t of state.texts) t.plays = 0;
    notify();
    send("DELETE", "/plays");
  },
};

// Lets the test harness wait for in-flight saves between tests.
(globalThis as { __taskVoiceIdle?: () => Promise<void> }).__taskVoiceIdle = () => store.whenIdle();
