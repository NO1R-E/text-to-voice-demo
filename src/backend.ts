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
  /** Times read aloud (all time, by anyone). */
  plays: number;
  /** False for another registered user's text (read-only). */
  isMine: boolean;
  /** Display name of the author (registered users only). */
  author?: string;
  /** How the owner wants it to sound: their preset, or their default voice for its language. */
  playback?: Playback;
}

export interface Playback {
  source: "preset" | "default";
  presetName?: string;
  voiceURI?: string;
  rate: number;
  pitch: number;
}

/** Who is using this browser. Everyone has a Supabase user; visitors are anonymous. */
export interface Account {
  userId: string;
  anonymous: boolean;
  email?: string;
  displayName?: string;
}

/** Default voices for texts without a preset, saved per account. */
export interface VoiceDefaults {
  voices: { th?: string; en?: string };
  rate: number;
  pitch: number;
}

export type Scope = "mine" | "everyone";
export type StatsScope = "mine" | "overall";

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
  top: { id: string; text: string; author?: string | null; plays: number; chars: number; lastPlayed: number }[];
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

// ---------- accounts ----------
/** The current user and, if registered, their display name. */
export async function getAccount(): Promise<Account> {
  const { data, error } = await sb().auth.getUser();
  if (error || !data.user) throw new Error(error?.message ?? "Not signed in");
  const u = data.user as { id: string; email?: string | null; is_anonymous?: boolean };
  const account: Account = { userId: u.id, anonymous: u.is_anonymous !== false, email: u.email ?? undefined };
  if (!account.anonymous) {
    const rows = await must<{ display_name: string }[]>(sb().from("profiles").select("display_name").eq("id", u.id));
    account.displayName = rows[0]?.display_name;
  }
  return account;
}

/**
 * Turn the current anonymous user into a registered one (same user id, so all
 * texts are kept). Supabase links the email first, then sets the password.
 * Returns "confirm" when Supabase is waiting for the email to be confirmed.
 */
export async function signUp(displayName: string, email: string, password: string): Promise<"done" | "confirm"> {
  const first = await sb().auth.updateUser({ email, data: { display_name: displayName } });
  if (first.error) throw new Error(first.error.message);
  const user = first.data.user as { email?: string | null; new_email?: string | null } | null;
  if (!user?.email && user?.new_email) return "confirm"; // "Confirm email" is on in Supabase
  const second = await sb().auth.updateUser({ password });
  if (second.error) throw new Error(second.error.message);
  return "done";
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Sign out, then start a fresh anonymous space (every visitor needs a user). */
export async function signOut(): Promise<void> {
  const { error } = await sb().auth.signOut();
  if (error) throw new Error(error.message);
  await ensureSession();
}

// ---------- reads ----------
type TextRow = {
  id: string;
  text: string;
  preset_id: string | null;
  created_at: string;
  plays: number;
  is_mine: boolean;
  author: string | null;
  play_source: "preset" | "default" | null;
  play_preset: string | null;
  play_voice: string | null;
  play_rate: number | null;
  play_pitch: number | null;
};
type PresetRow = { id: string; name: string; voice_uri: string | null; rate: number; pitch: number };

export async function loadState(scope: Scope = "mine"): Promise<{ texts: TextItem[]; presets: Preset[] }> {
  const [texts, presets] = await Promise.all([
    must<TextRow[]>(sb().rpc("list_texts", { p_scope: scope })),
    must<PresetRow[]>(sb().from("presets").select("id,name,voice_uri,rate,pitch").order("created_at", { ascending: true })),
  ]);
  return {
    texts: (texts ?? []).map((r) => ({
      id: r.id,
      text: r.text,
      presetId: r.preset_id ?? undefined,
      createdAt: new Date(r.created_at).getTime(),
      plays: r.plays ?? 0,
      isMine: r.is_mine !== false,
      author: r.author ?? undefined,
      playback: {
        source: r.play_source === "preset" ? "preset" : "default",
        presetName: r.play_preset ?? undefined,
        voiceURI: r.play_voice ?? undefined,
        rate: Number(r.play_rate ?? 1),
        pitch: Number(r.play_pitch ?? 1),
      },
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

type SettingsRow = { voice_th: string | null; voice_en: string | null; rate: number; pitch: number };

/** This account's default voices, or null if it never saved any. */
export async function getDefaults(): Promise<VoiceDefaults | null> {
  const rows = await must<SettingsRow[]>(sb().from("user_settings").select("voice_th,voice_en,rate,pitch"));
  const r = rows?.[0];
  if (!r) return null;
  return {
    voices: { th: r.voice_th ?? undefined, en: r.voice_en ?? undefined },
    rate: Number(r.rate),
    pitch: Number(r.pitch),
  };
}

export const saveDefaults = (userId: string, d: VoiceDefaults) =>
  must(
    sb()
      .from("user_settings")
      .upsert(
        {
          user_id: userId,
          voice_th: d.voices.th ?? null,
          voice_en: d.voices.en ?? null,
          rate: d.rate,
          pitch: d.pitch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      ),
  );

export const getStats = (days: number, tz: string, scope: StatsScope = "mine") =>
  must<Stats>(sb().rpc("get_stats", { p_days: days, p_tz: tz, p_scope: scope }));

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
