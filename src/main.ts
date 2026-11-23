import "./style.css";
import { store, type Preset, type TextItem } from "./store";
import { ping } from "./backend";
import {
  getVoices,
  isThai,
  isThaiVoice,
  LANG_LABEL,
  LANG_NAME,
  LANGS,
  languageOf,
  onVoicesChanged,
  resolveVoice,
  speak,
  stop,
  supportedVoices,
  ttsSupported,
  voiceLanguage,
  voicesFor,
  type Lang,
} from "./tts";
import { renderDashboard } from "./dashboard";
import { esc } from "./util";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";
import { setupAccount } from "./account";

// ---------- default voices (per account, saved in Supabase by the store) ----------
/** What `say()` needs: a voice plus speed/pitch (a Preset also fits this shape). */
interface VoiceSettings {
  voiceURI?: string;
  rate: number;
  pitch: number;
}
/**
 * The account's defaults: one voice per language + shared speed/pitch. This is a live
 * object owned by the store; it's refilled in place when the account changes.
 */
const settings = store.defaults;

/** The language a preset is for = its voice's language (null if not Thai/English). */
function presetLanguage(p: Preset): Lang | null {
  const v = getVoices().find((x) => x.voiceURI === p.voiceURI);
  return v ? voiceLanguage(v) : null;
}

/**
 * The preset that really applies to `text`: only presets in the text's language
 * count; otherwise the text uses its language's Auto voice. What's shown = what's heard.
 */
function effectivePresetId(text: string, presetId: string | undefined): string | undefined {
  const p = store.preset(presetId);
  return p && presetLanguage(p) === languageOf(text) ? p.id : undefined;
}

/** Settings used to read a text: its (effective) preset, else its language's defaults. */
function settingsFor(text: string, presetId: string | undefined): VoiceSettings {
  return (
    store.preset(effectivePresetId(text, presetId)) ?? {
      voiceURI: settings.voices[languageOf(text)],
      rate: settings.rate,
      pitch: settings.pitch,
    }
  );
}

const voiceOption = (v: SpeechSynthesisVoice, selected: boolean) =>
  `<option value="${esc(v.voiceURI)}" ${selected ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`;

/** Voice <option>s grouped by language (Thai, English). Other languages are hidden. */
function voiceOptions(selected: string | undefined): string {
  const all = supportedVoices();
  const pick = all.find((v) => v.voiceURI === selected) ?? all.find((v) => v.default) ?? all[0];
  return LANGS.map((lang) => {
    const vs = voicesFor(lang);
    return vs.length
      ? `<optgroup label="${LANG_LABEL[lang]}">${vs.map((v) => voiceOption(v, v === pick)).join("")}</optgroup>`
      : "";
  }).join("");
}

/** The voice a language's "Auto" option uses: the chosen default, or the system's. */
function autoVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  return resolveVoice(lang === "th" ? "ก" : "a", settings.voices[lang]);
}
function autoLabel(lang: Lang): string {
  const v = autoVoice(lang);
  return `Auto ${LANG_NAME[lang]} voice${v ? ` (${esc(v.name)})` : ""}`;
}

/**
 * Preset <option>s for a text in `lang`: only presets in that language, plus its
 * Auto option. A `selected` preset in another language falls back to Auto.
 */
function presetOptions(selected: string | undefined, lang: Lang): string {
  return (
    `<option value="">${autoLabel(lang)}</option>` +
    store.presets
      .filter((p) => presetLanguage(p) === lang)
      .map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`)
      .join("")
  );
}

/** Longest text you can type (the API accepts up to 5000, so older data still fits). */
const MAX_CHARS = 1000;
/** Long texts are clipped to 4 lines in their bubble with a Show more toggle. */
const isLongText = (text: string) => text.length > 180 || text.split("\n").length > 4;

const fmtRate = (n: number) => `${n.toFixed(1)}×`;
const fmtPitch = (n: number) => n.toFixed(1);

// ---------- layout ----------
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="top">
    <h1>Text Voice</h1>
    <div class="top-right">
      <nav class="tabs" role="tablist">
        <button role="tab" data-tab="texts" aria-selected="true">Texts</button>
        <button role="tab" data-tab="dashboard" aria-selected="false">Dashboard</button>
      </nav>
      <div class="theme-switch" role="group" aria-label="Theme">
        <button type="button" data-theme-choice="auto" title="Follow your browser / system setting">◐ Auto</button>
        <button type="button" data-theme-choice="light" title="Light theme">☀ Light</button>
        <button type="button" data-theme-choice="dark" title="Dark theme">☾ Dark</button>
      </div>
      <div id="account" class="account" aria-live="polite"></div>
    </div>
  </header>

  <section id="auth-panel" class="auth-panel" hidden aria-labelledby="auth-title">
    <form id="auth-form" class="auth-form" novalidate>
      <h2 id="auth-title">Sign up</h2>
      <p id="auth-hint" class="hint"></p>
      <p id="auth-warning" class="notice" hidden></p>
      <label id="auth-name-row">Display name
        <input id="auth-name" maxlength="40" autocomplete="nickname" placeholder="Shown on texts you share"></label>
      <label>Email <input id="auth-email" type="email" autocomplete="email"></label>
      <label>Password <input id="auth-password" type="password" autocomplete="new-password" placeholder="At least 6 characters"></label>
      <p id="auth-error" class="auth-error" role="alert"></p>
      <div class="auth-actions">
        <button type="button" id="auth-switch" class="link"></button>
        <span class="spacer"></span>
        <button type="button" id="auth-cancel" class="ghost">Cancel</button>
        <button type="submit" id="auth-submit" class="primary">Sign up</button>
      </div>
    </form>
  </section>

  <main>
    <section id="tab-texts" class="panel">
      <div class="panel-head">
        <p class="eyebrow">Write it once · hear it any time</p>
        <button type="button" id="db-status" class="status-pill" data-state="checking" title="Click to check the database connection again">
          <span class="dot" aria-hidden="true"></span><span class="status-label">Checking database…</span>
        </button>
      </div>
      <form id="add-form" class="add">
        <textarea id="new-text" rows="2" maxlength="${MAX_CHARS}" placeholder="Write some text… (Enter to add, Shift+Enter for new line)" required></textarea>
        <div class="add-actions">
          <select id="new-preset" class="preset-pick" aria-label="Voice preset for new text"></select>
          <span id="char-count" class="char-count" aria-live="polite">0 / ${MAX_CHARS}</span>
          <span class="spacer"></span>
          <button type="button" id="preview" class="ghost">▶ Preview</button>
          <button type="submit" class="primary">Add text</button>
        </div>
      </form>

      <details class="voice" ${ttsSupported ? "" : "open"}>
        <summary>Voice settings &amp; presets</summary>
        ${
          ttsSupported
            ? `<h4>Default voices</h4>
               <p class="hint">Used by texts without a preset ("Auto"). Each text is read by a voice in its own language: Thai or English.</p>
               <div class="voice-grid defaults">
                 ${LANGS.map(
                   (lang) => `<label>${LANG_LABEL[lang]} text
                   <span class="voice-pick">
                     <select id="voice-${lang}" data-lang="${lang}"></select>
                     <button type="button" class="ghost sm" data-preview-lang="${lang}" aria-label="Preview default ${LANG_NAME[lang]} voice">▶ Preview</button>
                   </span></label>`,
                 ).join("")}
                 <label>Speed <span id="rate-v">${fmtRate(settings.rate)}</span>
                   <input id="rate" type="range" min="0.5" max="2" step="0.1" value="${settings.rate}"></label>
                 <label>Pitch <span id="pitch-v">${fmtPitch(settings.pitch)}</span>
                   <input id="pitch" type="range" min="0" max="2" step="0.1" value="${settings.pitch}"></label>
               </div>
               <div class="presets-head">
                 <h4>Presets</h4>
                 <button type="button" id="add-preset" class="ghost">+ New preset</button>
               </div>
               <p class="hint">Edits save automatically and apply to every text using that preset.</p>
               <div id="presets" class="presets"></div>`
            : `<p class="warn">This browser doesn't support speech synthesis. Try Chrome or Edge.</p>`
        }
      </details>

      <div class="collection-head">
        <h2>All texts <span id="count" class="count-badge"></span></h2>
        <div id="scope" class="filters scope-switch" role="group" aria-label="Show texts" hidden>
          <button type="button" data-scope="mine" aria-pressed="true">Mine</button>
          <button type="button" data-scope="everyone" aria-pressed="false" title="Texts from all registered users">Everyone</button>
        </div>
      </div>
      <div class="toolbar">
        <label class="search">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <input id="search" type="search" placeholder="Search your texts…" aria-label="Search texts" autocomplete="off">
        </label>
        <select id="filter-preset" aria-label="Filter by voice preset"></select>
        <select id="sort" aria-label="Sort texts">
          <option value="played">Most played</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div id="notices"></div>
      <ul id="list" class="list"></ul>
    </section>

    <section id="tab-dashboard" class="panel" hidden></section>
  </main>
`;

// ---------- theme: Auto (browser) / Light / Dark ----------
function showTheme(t: Theme): void {
  app.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === t)),
  );
}
const initialTheme = loadTheme();
applyTheme(initialTheme);
showTheme(initialTheme);
app.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    const t = b.dataset.themeChoice as Theme;
    saveTheme(t);
    showTheme(t);
  }),
);

// Looked up before anything renders: the voice list loads immediately and draws presets.
const presetsEl = document.getElementById("presets");

// ---------- tabs ----------
let activeTab = "texts";
app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab!;
    app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.setAttribute("aria-selected", String(b === btn)),
    );
    document.getElementById("tab-texts")!.hidden = activeTab !== "texts";
    document.getElementById("tab-dashboard")!.hidden = activeTab !== "dashboard";
    if (activeTab === "dashboard") renderDashboard(document.getElementById("tab-dashboard")!);
  }),
);

// ---------- speaking ----------
// Key of whatever is currently speaking: a text id, "preset:<id>", or "preview".
let speakingKey: string | null = null;

function say(text: string, s: VoiceSettings, key: string, textId?: string): void {
  if (!ttsSupported || !text.trim()) return;
  if (speakingKey === key) {
    stop();
    speakingKey = null;
    renderList();
    return;
  }
  speakingKey = key;
  speak(text, {
    voiceURI: s.voiceURI,
    rate: s.rate,
    pitch: s.pitch,
    onEnd: () => {
      if (speakingKey === key) {
        speakingKey = null;
        renderList();
      }
    },
  });
  // Saved to Postgres for the dashboard: which voice/preset actually read it.
  if (textId) {
    store.recordPlay(textId, text.length, resolveVoice(text, s.voiceURI)?.voiceURI, "id" in s ? (s as Preset).id : undefined);
  }
  else renderList();
}

// ---------- default voice controls ----------
if (ttsSupported) {
  for (const lang of LANGS) {
    const sel = document.getElementById(`voice-${lang}`) as HTMLSelectElement;
    sel.addEventListener("change", () => {
      store.updateDefaults({ voices: { [lang]: sel.value } });
      // "Auto … voice (name)" labels changed
      renderNewPreset();
      renderList();
    });
  }
  // ▶ Preview a default voice with a short sample in its language (click again to stop).
  const SAMPLE: Record<Lang, string> = {
    th: "สวัสดีค่ะ นี่คือเสียงภาษาไทยเริ่มต้น",
    en: "Hello! This is the default English voice.",
  };
  document.querySelectorAll<HTMLButtonElement>("[data-preview-lang]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const lang = btn.dataset.previewLang as Lang;
      say(SAMPLE[lang], { voiceURI: settings.voices[lang], rate: settings.rate, pitch: settings.pitch }, `default:${lang}`);
    }),
  );
  for (const key of ["rate", "pitch"] as const) {
    const input = document.getElementById(key) as HTMLInputElement;
    input.addEventListener("input", () => {
      store.updateDefaults({ [key]: Number(input.value) });
      document.getElementById(`${key}-v`)!.textContent =
        key === "rate" ? fmtRate(settings.rate) : fmtPitch(settings.pitch);
    });
  }
}

/** Draw the Default voices controls from the account's defaults. */
function renderDefaultControls(): void {
  if (!ttsSupported) return;
  for (const lang of LANGS) {
    const sel = document.getElementById(`voice-${lang}`) as HTMLSelectElement;
    const vs = voicesFor(lang);
    const pick = autoVoice(lang);
    sel.innerHTML = vs.length
      ? vs.map((v) => voiceOption(v, v === pick)).join("")
      : `<option value="">No ${LANG_NAME[lang]} voice installed</option>`;
    sel.disabled = !vs.length;
  }
  for (const key of ["rate", "pitch"] as const) {
    (document.getElementById(key) as HTMLInputElement).value = String(settings[key]);
    document.getElementById(`${key}-v`)!.textContent = key === "rate" ? fmtRate(settings.rate) : fmtPitch(settings.pitch);
  }
}
// Signing in/out loads another account's defaults: redraw the controls when that happens.
let shownDefaultsVersion = -1;
store.subscribe(() => {
  if (store.defaultsVersion === shownDefaultsVersion) return;
  shownDefaultsVersion = store.defaultsVersion;
  renderDefaultControls();
  renderNewPreset();
});

// ---------- presets manager ----------

// Which preset card is open for editing (one at a time, like text bubbles).
let editingPresetId: string | null = null;
let presetsSignature = "";

function voiceName(uri: string | undefined): string {
  const v = getVoices().find((x) => x.voiceURI === uri);
  return v ? v.name.replace(/^Microsoft\s+/, "").replace(/\s+-\s+.*$/, "") : "Voice not installed";
}

/**
 * What the preset panel shows, minus the live fields of the card being edited.
 * Redraw only when this changes, so dragging a slider isn't interrupted.
 */
function presetsKey(): string {
  return (
    `${editingPresetId}|${getVoices().length}|` +
    store.presets
      .map((p) => (p.id === editingPresetId ? p.id : `${p.id}:${p.name}:${p.voiceURI}:${p.rate}:${p.pitch}`))
      .join(",")
  );
}

function renderPresets(force = true): void {
  if (!presetsEl) return;
  const key = presetsKey();
  if (!force && key === presetsSignature) return;
  presetsSignature = key;
  if (editingPresetId && !store.preset(editingPresetId)) editingPresetId = null;

  if (!store.presets.length) {
    presetsEl.innerHTML = `<p class="hint empty-presets">No presets yet. “+ New preset” copies the default voice so you can tweak it.</p>`;
    return;
  }
  const card = (p: Preset) => {
      const used = store.texts.filter((t) => t.presetId === p.id).length;
      const usedLabel = `<span class="muted preset-used" data-used="${p.id}">${used} text${used === 1 ? "" : "s"}</span>`;
      const test = `<button type="button" data-pact="test" class="ghost sm">▶ Test</button>`;
      const del = `<button type="button" data-pact="delete" class="ghost danger sm icon" aria-label="Delete preset ${esc(p.name)}" title="Delete">✕</button>`;

      if (p.id !== editingPresetId) {
        return `
      <div class="preset" data-preset="${p.id}">
        <div class="preset-row">
          <div class="preset-info">
            <span class="preset-title">${esc(p.name)}</span>
            <span class="preset-summary">${esc(voiceName(p.voiceURI))} · ${fmtRate(p.rate)} · pitch ${fmtPitch(p.pitch)}</span>
          </div>
          <div class="preset-actions">
            ${usedLabel}${test}
            <button type="button" data-pact="edit" class="ghost sm">✎ Edit</button>
            ${del}
          </div>
        </div>
      </div>`;
      }
      return `
      <div class="preset editing" data-preset="${p.id}">
        <div class="preset-row">
          <input class="preset-name" data-field="name" value="${esc(p.name)}" aria-label="Preset name" maxlength="40">
          <div class="preset-actions">
            ${usedLabel}${test}
            <button type="button" data-pact="done" class="primary sm">Done</button>
            ${del}
          </div>
        </div>
        <div class="voice-grid">
          <label>Voice <select data-field="voiceURI">${voiceOptions(p.voiceURI)}</select></label>
          <label>Speed <span data-out="rate">${fmtRate(p.rate)}</span>
            <input type="range" data-field="rate" min="0.5" max="2" step="0.1" value="${p.rate}"></label>
          <label>Pitch <span data-out="pitch">${fmtPitch(p.pitch)}</span>
            <input type="range" data-field="pitch" min="0" max="2" step="0.1" value="${p.pitch}"></label>
        </div>
      </div>`;
  };

  // Group cards by the language of their voice: Thai, English, then anything unsupported.
  const groups: { key: Lang | "other"; title: string; hint?: string }[] = [
    { key: "th", title: LANG_LABEL.th },
    { key: "en", title: LANG_LABEL.en },
    { key: "other", title: "Needs a new voice", hint: "This voice isn't Thai or English. Edit the preset and pick a Thai or English voice." },
  ];
  presetsEl.innerHTML = groups
    .map((g) => {
      const items = store.presets.filter((p) => (presetLanguage(p) ?? "other") === g.key);
      if (!items.length) return "";
      return `
      <section class="preset-group" data-lang="${g.key}">
        <h5 class="preset-group-title">${g.title} <span class="muted">${items.length}</span></h5>
        ${g.hint ? `<p class="hint">${g.hint}</p>` : ""}
        ${items.map(card).join("")}
      </section>`;
    })
    .join("");
}

if (presetsEl) {
  document.getElementById("add-preset")!.addEventListener("click", () => {
    editingPresetId = store.addPreset({
      name: `Preset ${store.presets.length + 1}`,
      // Start from the default English voice (or Thai if no English voice is installed).
      voiceURI: (autoVoice("en") ?? autoVoice("th"))?.voiceURI,
      rate: settings.rate,
      pitch: settings.pitch,
    });
    renderPresets(); // new presets open straight in edit mode
    presetsEl.querySelector<HTMLInputElement>(".preset.editing .preset-name")?.select();
  });

  // Enter in the name box = Done.
  presetsEl.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (el.matches(".preset-name") && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      editingPresetId = null;
      renderPresets();
    }
  });

  // Live edits: update the store without re-rendering the panel (keeps focus/drag).
  presetsEl.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const id = el.closest<HTMLElement>("[data-preset]")?.dataset.preset;
    const field = el.dataset.field as keyof Preset | undefined;
    if (!id || !field) return;
    if (field === "rate" || field === "pitch") {
      const n = Number(el.value);
      store.updatePreset(id, { [field]: n });
      el.closest("label")!.querySelector(`[data-out="${field}"]`)!.textContent =
        field === "rate" ? fmtRate(n) : fmtPitch(n);
    } else if (field === "name") {
      store.updatePreset(id, { name: el.value.trim() || "Untitled" });
    } else if (field === "voiceURI") {
      store.updatePreset(id, { voiceURI: el.value });
    }
  });

  presetsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-pact]");
    const id = btn?.closest<HTMLElement>("[data-preset]")?.dataset.preset;
    const p = store.preset(id);
    if (!btn || !p) return;
    switch (btn.dataset.pact) {
      case "test":
        say(`Hi, this is the ${p.name} preset.`, p, `preset:${p.id}`);
        break;
      case "edit":
        editingPresetId = p.id;
        renderPresets();
        presetsEl.querySelector<HTMLInputElement>(".preset.editing .preset-name")?.focus();
        break;
      case "done":
        editingPresetId = null;
        renderPresets();
        break;
      case "delete":
        if (editingPresetId === p.id) editingPresetId = null;
        store.deletePreset(p.id); // texts using it fall back to Default
        renderPresets();
        break;
    }
  });
}

// ---------- add form ----------
const form = document.getElementById("add-form") as HTMLFormElement;
const newText = document.getElementById("new-text") as HTMLTextAreaElement;
const newPreset = document.getElementById("new-preset") as HTMLSelectElement;

/** "" while the box is empty (no language yet), else the typed text's language. */
type FormMode = "" | Lang;
const formMode = (): FormMode => (newText.value.trim() ? languageOf(newText.value) : "");

function renderNewPreset(): void {
  const mode = formMode();
  if (mode) {
    newPreset.innerHTML = presetOptions(effectivePresetId(newText.value, newPreset.value), mode);
  } else {
    // Nothing typed yet: offer every preset, grouped by language, so you can pick first.
    const cur = store.preset(newPreset.value)?.id;
    newPreset.innerHTML =
      `<option value="">Auto voice (matches your text)</option>` +
      LANGS.map((lang) => {
        const ps = store.presets.filter((p) => presetLanguage(p) === lang);
        return ps.length
          ? `<optgroup label="${LANG_LABEL[lang]}">${ps
              .map((p) => `<option value="${p.id}" ${p.id === cur ? "selected" : ""}>${esc(p.name)}</option>`)
              .join("")}</optgroup>`
          : "";
      }).join("");
  }
  form.classList.toggle("thai-mode", mode === "th");
}

// Live "123 / 1000" counter; turns red in the last 10%.
const charCount = document.getElementById("char-count")!;
function renderCharCount(): void {
  const n = newText.value.length;
  charCount.textContent = `${n} / ${MAX_CHARS}`;
  charCount.classList.toggle("near", n >= MAX_CHARS * 0.9);
}
newText.addEventListener("input", renderCharCount);

// Re-filter the preset picker only when the mode changes (empty / Thai / English).
let lastFormMode: FormMode = "";
newText.addEventListener("input", () => {
  const mode = formMode();
  if (mode === lastFormMode) return;
  lastFormMode = mode;
  renderNewPreset();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = newText.value.trim();
  if (!text) return;
  const presetId = effectivePresetId(text, newPreset.value);
  newText.value = ""; // clear first so the re-render shows all presets again
  lastFormMode = "";
  renderCharCount();
  store.addText(text, presetId);
  newText.focus();
});
newText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
document
  .getElementById("preview")!
  .addEventListener("click", () => say(newText.value, settingsFor(newText.value, newPreset.value), "preview"));

// ---------- list (sorted by most used) ----------
const COPY_ICON = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

/** Copy a text to the clipboard and flash the button ("Copied!" / "Copy failed"). */
async function copyText(text: string, btn: HTMLElement): Promise<void> {
  let ok = true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Older/insecure contexts: copy via a temporary textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand?.("copy") ?? false;
      ta.remove();
    }
  } catch {
    ok = false;
  }
  btn.dataset.state = ok ? "copied" : "failed";
  btn.setAttribute("aria-label", ok ? "Copied!" : "Copy failed");
  btn.title = ok ? "Copied!" : "Copy failed";
  if (ok) btn.innerHTML = CHECK_ICON;
  setTimeout(() => {
    delete btn.dataset.state;
    btn.setAttribute("aria-label", "Copy text");
    btn.title = "Copy text";
    btn.innerHTML = COPY_ICON;
  }, 1500);
}

let editingId: string | null = null;
/** Long texts the user has expanded ("Show more"); kept across re-renders. */
const expanded = new Set<string>();
const list = document.getElementById("list") as HTMLUListElement;

// ---------- search / filter / sort ----------
type Sort = "played" | "newest" | "oldest";
const SORT_KEY = "task-voice:sort";
const searchInput = document.getElementById("search") as HTMLInputElement;
const filterSel = document.getElementById("filter-preset") as HTMLSelectElement;
const sortSel = document.getElementById("sort") as HTMLSelectElement;
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (saved === "played" || saved === "newest" || saved === "oldest") sortSel.value = saved;
} catch {
  /* ignore */
}

const SORTERS: Record<Sort, (a: { plays: number; createdAt: number }, b: { plays: number; createdAt: number }) => number> = {
  played: (a, b) => b.plays - a.plays || b.createdAt - a.createdAt,
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
};

function renderFilterOptions(): void {
  const cur = filterSel.value;
  filterSel.innerHTML =
    `<option value="all">All presets</option><option value="default">Default voice</option>` +
    store.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  filterSel.value = [...filterSel.options].some((o) => o.value === cur) ? cur : "all";
}

searchInput.addEventListener("input", () => renderList());
filterSel.addEventListener("change", () => renderList());
sortSel.addEventListener("change", () => {
  try {
    localStorage.setItem(SORT_KEY, sortSel.value);
  } catch {
    /* ignore */
  }
  renderList();
});

function renderList(): void {
  const all = store.texts.map((t) => ({ ...t, plays: store.playCount(t.id) }));
  const q = searchInput.value.trim().toLocaleLowerCase();
  const filter = filterSel.value || "all";
  const items = all
    .filter((t) => !q || t.text.toLocaleLowerCase().includes(q))
    .filter((t) => {
      if (filter === "all") return true;
      const pid = effectivePresetId(t.text, t.presetId);
      return filter === "default" ? !pid : pid === filter;
    })
    .sort(SORTERS[(sortSel.value as Sort) || "played"]);
  document.getElementById("count")!.textContent =
    items.length === all.length ? String(all.length) : `${items.length} of ${all.length}`;

  const needsThai = items.some((t) => isThai(t.text)) || isThai(newText.value);
  const hasThaiVoice = getVoices().some(isThaiVoice);
  document.getElementById("notices")!.innerHTML =
    (store.error ? `<p id="db-error" class="notice" role="alert">${esc(store.error)}</p>` : "") +
    (ttsSupported && needsThai && !hasThaiVoice
      ? `<p id="thai-warning" class="notice">No Thai voice is installed, so Thai text may be silent or read wrongly.
         Add one in Windows Settings › Time &amp; language › Speech › Add voices (Thai), or open this page in Microsoft Edge.</p>`
      : "");

  if (!items.length) {
    list.innerHTML = all.length
      ? `<li class="empty">No texts match${q ? ` “${esc(searchInput.value.trim())}”` : " this filter"}.</li>`
      : `<li class="empty">No texts yet. Write one above and press Add.</li>`;
    return;
  }

  list.innerHTML = items
    .map((t) => {
      const playing = speakingKey === t.id;
      const editing = editingId === t.id;
      const long = isLongText(t.text);
      const open = expanded.has(t.id);
      const body = editing
        ? `<textarea class="edit" data-edit="${t.id}" rows="3" maxlength="${MAX_CHARS}">${esc(t.text)}</textarea>`
        : `<p class="text ${long && !open ? "clamped" : ""}">${esc(t.text)}</p>`;
      const lang = languageOf(t.text);
      if (!t.isMine) return othersBubble(t, { playing, long, open, body, lang });
      return `
        <li class="bubble ${playing ? "playing" : ""}" data-id="${t.id}">
          <div class="speech-wrap">
            <div class="speech ${long ? "long" : ""}">${body}</div>
            ${long && !editing ? `<button type="button" class="link sm" data-act="more" aria-expanded="${open}">${open ? "Show less" : "Show more"}</button>` : ""}
          </div>
          <div class="bubble-foot">
            <div class="bubble-tools">
              ${lang === "th" ? `<span class="lang-tag" title="Thai text: read with a Thai voice">ไทย</span>` : ""}
              <select class="preset-pick" data-pick data-lang="${lang}" aria-label="Voice preset">${presetOptions(effectivePresetId(t.text, t.presetId), lang)}</select>
              ${
                editing
                  ? `<button data-act="save" class="primary sm">Save</button>
                     <button data-act="cancel" class="ghost sm">Cancel</button>`
                  : `<button data-act="edit" class="ghost sm" aria-label="Edit text">✎ Edit</button>`
              }
            </div>
            <div class="actions">
              <span class="meta">${t.plays} play${t.plays === 1 ? "" : "s"}</span>
              <button data-act="speak" class="${playing ? "primary" : "ghost"} sm" ${ttsSupported ? "" : "disabled"}
                aria-label="${playing ? "Stop" : "Read aloud"}">${playing ? "■ Stop" : "▶ Speak"}</button>
              <button data-act="copy" class="ghost sm icon" aria-label="Copy text" title="Copy text">${COPY_ICON}</button>
              <button data-act="delete" class="ghost danger sm icon" aria-label="Delete text" title="Delete">✕</button>
            </div>
          </div>
        </li>`;
    })
    .join("");

  const editor = list.querySelector<HTMLTextAreaElement>("textarea.edit");
  if (editor && document.activeElement?.closest(".presets") == null) {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
}

/**
 * How someone else's text is spoken here: the owner's voice (their preset, or their default
 * for the text's language) with the owner's speed and pitch. If that voice isn't installed
 * on this device, this user's default voice for the language is used, still at the owner's
 * speed and pitch.
 */
function othersSettings(t: TextItem): VoiceSettings & { ownerVoiceHere: boolean } {
  const lang = languageOf(t.text);
  const pb = t.playback;
  const owners = getVoices().find((v) => v.voiceURI === pb?.voiceURI);
  const ownerVoiceHere = !!owners && voiceLanguage(owners) === lang;
  return {
    voiceURI: ownerVoiceHere ? owners!.voiceURI : settings.voices[lang],
    rate: pb?.rate ?? settings.rate,
    pitch: pb?.pitch ?? settings.pitch,
    ownerVoiceHere,
  };
}

/** "Ada's preset “Calm”" / "Ada's default voice", with details on hover. */
function voiceInfo(t: TextItem): string {
  const who = `${t.author ?? "Owner"}'s`;
  const pb = t.playback;
  const label = pb?.source === "preset" && pb.presetName ? `${who} preset “${pb.presetName}”` : `${who} default voice`;
  const s = othersSettings(t);
  const used = getVoices().find((v) => v.voiceURI === s.voiceURI) ?? autoVoice(languageOf(t.text));
  const detail = s.ownerVoiceHere
    ? `${used?.name ?? "voice"} · ${fmtRate(s.rate)} · pitch ${fmtPitch(s.pitch)}`
    : `${who} voice is not on this device, so ${used?.name ?? "your default voice"} is used · ${fmtRate(s.rate)} · pitch ${fmtPitch(s.pitch)}`;
  return `<span class="voice-info" title="${esc(detail)}">🔊 ${esc(label)}</span>`;
}

/** Another registered user's text: read-only (play + copy), with its author. */
function othersBubble(
  t: TextItem,
  v: { playing: boolean; long: boolean; open: boolean; body: string; lang: Lang },
): string {
  return `
        <li class="bubble others ${v.playing ? "playing" : ""}" data-id="${t.id}">
          <div class="speech-wrap">
            <div class="speech ${v.long ? "long" : ""}">${v.body}</div>
            ${v.long ? `<button type="button" class="link sm" data-act="more" aria-expanded="${v.open}">${v.open ? "Show less" : "Show more"}</button>` : ""}
          </div>
          <div class="bubble-foot">
            <div class="bubble-tools">
              ${v.lang === "th" ? `<span class="lang-tag" title="Thai text: read with a Thai voice">ไทย</span>` : ""}
              <span class="author">by ${esc(t.author ?? "someone")}</span>
              ${voiceInfo(t)}
            </div>
            <div class="actions">
              <span class="meta">${t.plays} play${t.plays === 1 ? "" : "s"}</span>
              <button data-act="speak" class="${v.playing ? "primary" : "ghost"} sm" ${ttsSupported ? "" : "disabled"}
                aria-label="${v.playing ? "Stop" : "Read aloud"}">${v.playing ? "■ Stop" : "▶ Speak"}</button>
              <button data-act="copy" class="ghost sm icon" aria-label="Copy text" title="Copy text">${COPY_ICON}</button>
            </div>
          </div>
        </li>`;
}

function saveEdit(id: string): void {
  const ta = list.querySelector<HTMLTextAreaElement>(`[data-edit="${id}"]`);
  const text = ta?.value.trim();
  editingId = null;
  if (!text) return renderList();
  const item = store.texts.find((t) => t.id === id);
  // Text changed language: drop a preset whose voice can't speak it.
  if (item && item.presetId && effectivePresetId(text, item.presetId) !== item.presetId) {
    store.setTextPreset(id, undefined);
  }
  store.updateText(id, text);
}

// Language mode while editing a bubble: re-filter its preset picker as soon as the language flips.
list.addEventListener("input", (e) => {
  const ta = e.target as HTMLTextAreaElement;
  if (!ta.matches("textarea.edit")) return;
  const bubble = ta.closest<HTMLElement>("[data-id]")!;
  const item = store.texts.find((t) => t.id === bubble.dataset.id);
  const pick = bubble.querySelector<HTMLSelectElement>("[data-pick]")!;
  const lang = languageOf(ta.value);
  if (pick.dataset.lang === lang) return;
  pick.dataset.lang = lang;
  pick.innerHTML = presetOptions(effectivePresetId(ta.value, item?.presetId), lang);
  bubble.querySelector(".lang-tag")?.toggleAttribute("hidden", lang !== "th");
});

list.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  const id = el?.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (!el || !id) return;
  const item = store.texts.find((t) => t.id === id);
  if (!item) return;
  // Others' texts are read-only: only play, copy and show more.
  if (!item.isMine && !["speak", "copy", "more"].includes(el.dataset.act ?? "")) return;
  switch (el.dataset.act) {
    case "speak":
      say(item.text, item.isMine ? settingsFor(item.text, item.presetId) : othersSettings(item), id, id);
      break;
    case "edit":
      editingId = id;
      renderList();
      break;
    case "save":
      saveEdit(id);
      break;
    case "copy":
      void copyText(item.text, el);
      break;
    case "more":
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderList();
      break;
    case "cancel":
      editingId = null;
      renderList();
      break;
    case "delete":
      if (speakingKey === id) stop();
      if (editingId === id) editingId = null;
      store.deleteText(id);
      break;
  }
});
list.addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (!sel.matches("[data-pick]")) return;
  const id = sel.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (id) {
    store.setTextPreset(id, sel.value || undefined);
    renderPresets(); // refresh "used by" counts
  }
});
list.addEventListener("keydown", (e) => {
  const ta = e.target as HTMLElement;
  if (!ta.matches("textarea.edit")) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    saveEdit(ta.dataset.edit!);
  } else if (e.key === "Escape") {
    editingId = null;
    renderList();
  }
});

store.subscribe(() => {
  renderPresets(false); // only redraws if presets changed (never mid-edit)
  renderFilterOptions(); // presets may have changed
  renderList();
  renderNewPreset();
  presetsEl?.querySelectorAll<HTMLElement>("[data-used]").forEach((s) => {
    const n = store.texts.filter((t) => t.presetId === s.dataset.used).length;
    s.textContent = `${n} text${n === 1 ? "" : "s"}`;
  });
  if (activeTab === "dashboard") renderDashboard(document.getElementById("tab-dashboard")!);
});
// ---------- database status pill ----------
const statusEl = document.getElementById("db-status") as HTMLButtonElement;
let health: { state: "checking" | "ok" | "offline"; latencyMs?: number } = { state: "checking" };

function renderStatus(): void {
  let state: string = health.state;
  let label = "Checking database…";
  let title = "Click to check the database connection again";
  if (health.state === "offline") {
    label = "Database offline";
    title = "Can't reach Supabase: changes won't be saved. Check your internet connection. Click to retry.";
  } else if (health.state === "ok") {
    if (store.pendingSaves > 0) {
      state = "saving";
      label = "Saving…";
    } else if (store.error?.startsWith("Couldn't save")) {
      state = "error";
      label = "Last save failed";
      title = `${store.error} Click to check again.`;
    } else {
      label = "Saved to database";
      title = `Connected to Supabase (${health.latencyMs} ms). Click to check again.`;
    }
  }
  statusEl.dataset.state = state;
  statusEl.querySelector(".status-label")!.textContent = label;
  statusEl.title = title;
}

let checking = false;
async function checkHealth(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const started = performance.now();
    await ping();
    health = { state: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch {
    health = { state: "offline" };
  } finally {
    checking = false;
  }
  renderStatus();
}

statusEl.addEventListener("click", () => {
  health = { ...health, state: "checking" };
  renderStatus();
  void checkHealth();
});
store.onSync(renderStatus);
store.subscribe(renderStatus);
// Re-check every 20 s while the tab is visible, and when coming back to it.
setInterval(() => {
  if (document.visibilityState === "visible") void checkHealth();
}, 20_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkHealth();
});

// Sign in (anonymously, once per browser) and load texts + presets before the first full render.
setupAccount();
renderFilterOptions();
void checkHealth();
await store.init();

// Registered last: it fires immediately and redraws everything that lists voices.
if (ttsSupported) {
  onVoicesChanged(() => {
    // Voices can load after settings did: put a migrated voice in its real language slot.
    for (const lang of LANGS) {
      const v = getVoices().find((x) => x.voiceURI === settings.voices[lang]);
      const actual = v ? voiceLanguage(v) : null;
      if (v && actual && actual !== lang) {
        const voices = { ...settings.voices };
        voices[actual] ??= v.voiceURI;
        delete voices[lang];
        settings.voices = voices;
        store.updateDefaults({}); // save the corrected slots
      }
    }
    renderDefaultControls();
    renderPresets();
    renderNewPreset();
    renderList();
  });
} else {
  renderNewPreset();
  renderPresets();
  renderList();
}
