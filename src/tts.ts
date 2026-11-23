/**
 * Text-to-speech using the browser's built-in Web Speech API (speechSynthesis).
 * Free, no API key, works offline with the OS voices (Windows ships several).
 *
 * To swap in a neural model later (e.g. Kokoro via kokoro-js, or a cloud API),
 * keep the same `speak(text, opts)` signature and replace the body.
 */

export interface SpeakOptions {
  voiceURI?: string;
  rate: number;
  pitch: number;
  onEnd?: () => void;
}

export const ttsSupported = "speechSynthesis" in window;

export function getVoices(): SpeechSynthesisVoice[] {
  return ttsSupported ? speechSynthesis.getVoices() : [];
}

/** Thai Unicode block (U+0E00–U+0E7F). Any Thai character marks the text as Thai. */
const THAI_RE = /[฀-๿]/;
export const isThai = (text: string): boolean => THAI_RE.test(text);

// ---------- the two supported languages ----------
/** We support exactly two languages: Thai and English. Everything else is hidden. */
export type Lang = "th" | "en";
export const LANGS: readonly Lang[] = ["th", "en"];
export const LANG_LABEL: Record<Lang, string> = { th: "ไทย · Thai", en: "English" };
export const LANG_NAME: Record<Lang, string> = { th: "Thai", en: "English" };
/** BCP-47 tag to ask the browser for when no matching voice is installed. */
const LANG_TAG: Record<Lang, string> = { th: "th-TH", en: "en-US" };

/** Any Thai character makes the text Thai; everything else is treated as English. */
export const languageOf = (text: string): Lang => (isThai(text) ? "th" : "en");

/** "th-TH" → "th", "en-GB"/"en_US" → "en", anything else → null (unsupported). */
export function voiceLanguage(v: Pick<SpeechSynthesisVoice, "lang">): Lang | null {
  const l = v.lang.toLowerCase().replace("_", "-");
  if (l === "th" || l.startsWith("th-")) return "th";
  if (l === "en" || l.startsWith("en-")) return "en";
  return null;
}
export const isThaiVoice = (v: Pick<SpeechSynthesisVoice, "lang">): boolean => voiceLanguage(v) === "th";

/** Installed voices we support (Thai + English), in the browser's order. */
export const supportedVoices = (): SpeechSynthesisVoice[] => getVoices().filter((v) => voiceLanguage(v) !== null);
export const voicesFor = (lang: Lang): SpeechSynthesisVoice[] => getVoices().filter((v) => voiceLanguage(v) === lang);

/**
 * The voice that should actually read `text`: the requested one if it speaks the
 * text's language, otherwise that language's system-default voice (or its first).
 * Undefined only when no voice for that language is installed.
 */
export function resolveVoice(text: string, voiceURI: string | undefined): SpeechSynthesisVoice | undefined {
  const lang = languageOf(text);
  const wanted = getVoices().find((v) => v.voiceURI === voiceURI);
  if (wanted && voiceLanguage(wanted) === lang) return wanted;
  const candidates = voicesFor(lang);
  return candidates.find((v) => v.default) ?? candidates[0];
}

/** Voices load asynchronously in Chrome/Edge; call back whenever the list changes. */
export function onVoicesChanged(fn: () => void): void {
  if (!ttsSupported) return;
  speechSynthesis.addEventListener("voiceschanged", fn);
  fn();
}

/**
 * Chrome stops long utterances after ~15s, so split into sentence-sized chunks
 * and queue them.
 */
function chunk(text: string, max = 200): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function speak(text: string, opts: SpeakOptions): void {
  if (!ttsSupported) return;
  speechSynthesis.cancel();
  const voice = resolveVoice(text, opts.voiceURI);
  const lang = languageOf(text);
  const parts = chunk(text);
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = LANG_TAG[lang]; // no matching voice installed: let the browser pick one
    }
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    if (i === parts.length - 1 && opts.onEnd) {
      u.onend = opts.onEnd;
      u.onerror = opts.onEnd;
    }
    speechSynthesis.speak(u);
  });
}

export function stop(): void {
  if (ttsSupported) speechSynthesis.cancel();
}
