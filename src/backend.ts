/**
 * All data access goes through here: the browser talks to Supabase directly with the
 * public anon key. Each visitor is signed in anonymously, and Row Level Security
 * (supabase/schema.sql) keeps every visitor's texts private to them.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface TextItem {
  id: string;
  text: string;
  createdAt: number;
  /** Voice preset used to read this text; undefined = Auto voice. */
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

export interface Stats {
  range: { days: number; start: string; end: string; tz: string };
  totals: { plays: number; chars: number; texts: number };
  top: { id: string; text: string; plays: number; chars: number; lastPlayed: number }[];
  daily: { day: string; plays: number }[];
}

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!URL_ || !KEY) {
    throw new Error("Supabase isn't configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)");
  }
  client ??= createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

type Res<T> = { data: T | null; error: { message: string } | null };
async function must<T>(q: PromiseLike<Res<T>>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as T;
}

// ---------- session ----------
/** Make sure this browser has a (anonymous) Supabase user; reuses the stored one. */
export async function ensureSession(): Promise<void> {
  const { data, error } = await sb().auth.getSession();
  if (error) throw new Error(error.message);
  if (data.session) return;
  const res = await sb().auth.signInAnonymously();
  if (res.error) throw new Error(res.error.message);
}

// ---------- reads ----------
type TextRow = { id: string; text: string; preset_id: string | null; created_at: string; plays: number };
type PresetRow = { id: string; name: string; voice_uri: string | null; rate: number; pitch: number };

export async function loadState(): Promise<{ texts: TextItem[]; presets: Preset[] }> {
  const [texts, presets] = await Promise.all([
    must<TextRow[]>(sb().from("text_list").select("*").order("created_at", { ascending: false })),
    must<PresetRow[]>(sb().from("presets").select("id,name,voice_uri,rate,pitch").order("created_at", { ascending: true })),
  ]);
  return {
    texts: texts.map((r) => ({
      id: r.id,
      text: r.text,
      presetId: r.preset_id ?? undefined,
      createdAt: new Date(r.created_at).getTime(),
      plays: r.plays ?? 0,
    })),
    presets: presets.map((r) => ({
      id: r.id,
      name: r.name,
      voiceURI: r.voice_uri ?? undefined,
      rate: Number(r.rate),
      pitch: Number(r.pitch),
    })),
  };
}

export const getStats = (days: number, tz: string) =>
  must<Stats>(sb().rpc("get_stats", { p_days: days, p_tz: tz }));

/** Connection check for the status pill. */
export const ping = () => must<{ ok: boolean }>(sb().rpc("ping"));

// ---------- writes ----------
export const insertText = (t: { id: string; text: string; presetId?: string }) =>
  must(sb().from("texts").insert({ id: t.id, text: t.text, preset_id: t.presetId ?? null }));

export function updateText(id: string, patch: { text?: string; presetId?: string | null }) {
  const row: Record<string, unknown> = {};
  if (patch.text !== undefined) row.text = patch.text;
  if (patch.presetId !== undefined) row.preset_id = patch.presetId;
  return must(sb().from("texts").update(row).eq("id", id));
}

export const deleteText = (id: string) => must(sb().from("texts").delete().eq("id", id));

const presetRow = (p: Omit<Preset, "id">) => ({
  name: p.name,
  voice_uri: p.voiceURI ?? null,
  rate: p.rate,
  pitch: p.pitch,
});
export const insertPreset = (p: Preset) => must(sb().from("presets").insert({ id: p.id, ...presetRow(p) }));
export const updatePreset = (p: Preset) => must(sb().from("presets").update(presetRow(p)).eq("id", p.id));
export const deletePreset = (id: string) => must(sb().from("presets").delete().eq("id", id));

export const insertPlay = (textId: string, chars: number, voiceURI?: string, presetId?: string) =>
  must(
    sb().from("plays").insert({ text_id: textId, chars, voice_uri: voiceURI ?? null, preset_id: presetId ?? null }),
  );

export const clearPlays = () => must(sb().rpc("clear_plays"));
