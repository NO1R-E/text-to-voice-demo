import { getStats, type Stats, type StatsScope } from "./backend";
import { store } from "./store";
import { getVoices } from "./tts";
import { esc } from "./util";

const RANGES = { 7: "7 days", 30: "30 days", 0: "All time" } as const;
type Range = keyof typeof RANGES;
let range: Range = 30;
/** "mine" = your texts (played by anyone); "overall" = all registered users' texts. */
let dashScope: StatsScope = "mine";
let renderToken = 0;

const tz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

// ---------- formatting ----------
/** "2026-11-23" → Date at local midnight. */
function localDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const fmtDay = (day: string) => localDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function truncate(s: string, n = 48): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** "Microsoft David - English (United States)" → "David"; unknown voices keep their id. */
function voiceLabel(uri: string): string {
  const name = getVoices().find((v) => v.voiceURI === uri)?.name ?? uri;
  return name.replace(/^Microsoft\s+/, "").replace(/\s+-\s+.*$/, "").replace(/\s+Online \(Natural\)/, " (Natural)");
}

// ---------- chart pieces (plain HTML, styled in style.css) ----------
/** Tooltip text goes through innerHTML: escape twice so user text stays text. */
const tip = (html: string) => esc(html);

/** Ranked horizontal bars. Only the top value is labelled; the rest are in tooltips + table. */
function hbars(rows: { label: string; value: number; tip: string }[]): string {
  const max = rows[0]?.value ?? 0;
  return `<div class="hbars">${rows
    .map(
      (r, i) => `
      <div class="hbar-row" data-tip="${tip(r.tip)}">
        <span class="hbar-label">${esc(r.label)}</span>
        <span class="hbar-track">
          <span class="hbar" style="width:${max ? (r.value / max) * 100 : 0}%"></span>
          ${i === 0 ? `<span class="hbar-val">${r.value.toLocaleString()}</span>` : ""}
        </span>
      </div>`,
    )
    .join("")}</div>`;
}

/** 100% stacked bar of 2 parts with a legend (direct labels: name, count, share). */
function split(parts: { name: string; value: number; cls: string }[]): string {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  return `
    <div class="split" role="img" aria-label="${esc(parts.map((p) => `${p.name} ${pct(p.value, total)}%`).join(", "))}">
      ${visible
        .map(
          (p) =>
            `<span class="seg ${p.cls}" style="flex-grow:${p.value}" data-tip="${tip(`<b>${esc(p.name)}</b><br>${plural(p.value, "play")} · ${pct(p.value, total)}%`)}"></span>`,
        )
        .join("")}
    </div>
    <ul class="legend">
      ${parts
        .map(
          (p) => `<li><span class="swatch ${p.cls}" aria-hidden="true"></span>
            <span class="legend-name">${esc(p.name)}</span>
            <span class="legend-val">${p.value.toLocaleString()} · ${pct(p.value, total)}%</span></li>`,
        )
        .join("")}
    </ul>`;
}

function card(key: string, title: string, sub: string, body: string, wide = false): string {
  return `<section class="card dash-card ${wide ? "wide" : ""}" data-card="${key}">
      <h3>${title}</h3><p class="sub">${sub}</p>${body}</section>`;
}
const empty = (msg = "No plays in this range yet.") => `<p class="empty">${msg}</p>`;

/** Fill in fields an older database schema doesn't return yet, so the page still renders. */
function withDefaults(s: Stats): Stats {
  return {
    ...s,
    totals: { ...s.totals, listeners: s.totals.listeners ?? 0 },
    languages: s.languages ?? { th: 0, en: 0 },
    hours: s.hours?.length === 24 ? s.hours : Array(24).fill(0),
    voices: s.voices ?? [],
    authors: s.authors ?? null,
    listenedBy: s.listenedBy ?? null,
  };
}

// ---------- render ----------
/** Fetches stats from Supabase (after pending saves land) and draws the dashboard. */
export async function renderDashboard(root: HTMLElement): Promise<void> {
  const token = ++renderToken;
  if (!root.hasChildNodes()) root.innerHTML = `<p class="muted">Loading…</p>`;

  let s: Stats;
  try {
    await store.whenIdle();
    if (!store.registered) dashScope = "mine"; // overall is for registered users
    s = withDefaults(await getStats(range, tz, dashScope));
  } catch (e) {
    if (token === renderToken) {
      root.innerHTML = `<p class="notice" role="alert">Couldn't load dashboard data from the database: ${esc(
        e instanceof Error ? e.message : String(e),
      )}</p>`;
    }
    return;
  }
  if (token !== renderToken) return; // a newer render is on its way

  const overall = dashScope === "overall";
  const by = (author?: string | null) => (overall && author ? ` · by ${esc(author)}` : "");
  const most = s.top[0];
  const total = s.totals.plays;
  const maxDaily = Math.max(1, ...s.daily.map((d) => d.plays));
  const maxHour = Math.max(1, ...s.hours);
  const peak = s.hours.indexOf(Math.max(...s.hours));

  const tiles = `
    <div class="tiles">
      <div class="tile"><span class="label">Times read aloud</span><span class="value" data-stat="plays">${total.toLocaleString()}</span></div>
      <div class="tile"><span class="label">Listeners</span><span class="value" data-stat="listeners">${s.totals.listeners.toLocaleString()}</span></div>
      <div class="tile"><span class="label">Characters spoken</span><span class="value" data-stat="chars">${s.totals.chars.toLocaleString()}</span></div>
      <div class="tile"><span class="label">${overall ? "Shared texts" : "Your texts"}</span><span class="value" data-stat="texts">${s.totals.texts.toLocaleString()}</span></div>
      <div class="tile wide"><span class="label">${overall ? "Best text overall" : "Your most played"}</span>
        <span class="value text">${most ? esc(truncate(most.text, 60)) : "—"}</span>
        ${most ? `<span class="muted">${plural(most.plays, "play")}${by(most.author)}</span>` : ""}
      </div>
    </div>`;

  const topCard = card(
    "top",
    overall ? "Best texts overall" : "Most played texts",
    `${overall ? "All registered users' texts" : "Your texts"}, played by anyone · top ${Math.min(10, s.top.length) || 10}`,
    s.top.length
      ? hbars(
          s.top.slice(0, 10).map((r) => ({
            label: truncate(r.text, 36),
            value: r.plays,
            tip: `<b>${esc(truncate(r.text, 80))}</b><br>${plural(r.plays, "play")}${by(r.author)} · last ${fmtDate(r.lastPlayed)}`,
          })),
        )
      : empty("No plays in this range yet. Press ▶ Speak on a text."),
    true,
  );

  const dailyCard = card(
    "daily",
    "Plays per day",
    `${fmtDay(s.range.start)} – ${fmtDay(s.range.end)}`,
    `<div class="cols-wrap">
        <div class="cols" style="--n:${s.daily.length}">
          ${s.daily
            .map(
              (d) => `<div class="col-hit" data-tip="${tip(`<b>${fmtDay(d.day)}</b><br>${plural(d.plays, "play")}`)}">
                <span class="col" style="height:${(d.plays / maxDaily) * 100}%"></span></div>`,
            )
            .join("")}
        </div>
        <div class="cols-axis"><span>${fmtDay(s.range.start)}</span><span>Today</span></div>
      </div>`,
    true,
  );

  const langCard = card(
    "languages",
    "Thai vs English",
    "Share of plays by the text's language",
    total
      ? split([
          { name: "English", value: s.languages.en, cls: "s1" },
          { name: "Thai · ไทย", value: s.languages.th, cls: "s2" },
        ])
      : empty(),
  );

  const hoursCard = card(
    "hours",
    "Busiest hours",
    total ? `Peak around ${hourLabel(peak)} · your time zone` : "Plays by hour of day · your time zone",
    `<div class="hours" aria-label="Plays by hour of day">
        ${s.hours
          .map(
            (n, h) => `<div class="hour-hit" data-tip="${tip(`<b>${hourLabel(h)}–${hourLabel((h + 1) % 24)}</b><br>${plural(n, "play")}`)}">
              <span class="hour ${n && h === peak ? "peak" : ""}" style="height:${(n / maxHour) * 100}%"></span></div>`,
          )
          .join("")}
      </div>
      <div class="cols-axis hours-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`,
  );

  const voicesCard = card(
    "voices",
    "Top voices",
    "Voices used to read these texts",
    s.voices.length
      ? hbars(
          s.voices.map((v) => ({
            label: voiceLabel(v.voice),
            value: v.plays,
            tip: `<b>${esc(voiceLabel(v.voice))}</b><br>${plural(v.plays, "play")} · ${pct(v.plays, total)}%`,
          })),
        )
      : empty(),
  );

  const lastCard = overall
    ? card(
        "authors",
        "Top authors",
        "Whose texts get played the most",
        s.authors?.length
          ? hbars(
              s.authors.map((a) => ({
                label: a.author,
                value: a.plays,
                tip: `<b>${esc(a.author)}</b><br>${plural(a.plays, "play")} across ${plural(a.texts, "text")}`,
              })),
            )
          : empty(),
      )
    : card(
        "listeners",
        "Who listens to your texts",
        "Your own plays vs plays by other people",
        total && s.listenedBy
          ? split([
              { name: "You", value: s.listenedBy.me, cls: "s1" },
              { name: "Others", value: s.listenedBy.others, cls: "s2" },
            ])
          : empty(),
      );

  const table = `
    <details class="card table-card">
      <summary>Table view</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Text</th>${overall ? "<th>Author</th>" : ""}<th class="num">Plays</th><th class="num">Chars spoken</th><th>Last played</th></tr></thead>
          <tbody>
            ${
              s.top.length
                ? s.top
                    .map(
                      (r) => `<tr><td>${esc(truncate(r.text, 80))}</td>${overall ? `<td>${esc(r.author ?? "")}</td>` : ""}
                        <td class="num">${r.plays.toLocaleString()}</td><td class="num">${r.chars.toLocaleString()}</td>
                        <td>${new Date(r.lastPlayed).toLocaleString()}</td></tr>`,
                    )
                    .join("")
                : `<tr><td colspan="${overall ? 5 : 4}" class="muted">No data</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </details>`;

  root.innerHTML = `
    <div class="dash-head">
      <div>
        <h2>Dashboard</h2>
        <p class="sub">${overall ? "Everyone's shared texts" : "Your texts"} · ${RANGES[range]}</p>
      </div>
      <div class="dash-controls">
        ${
          store.registered
            ? `<div class="seg-control" role="group" aria-label="Whose texts">
                 <button data-dash-scope="mine" aria-pressed="${String(!overall)}" title="Your texts, played by anyone">Mine</button>
                 <button data-dash-scope="overall" aria-pressed="${String(overall)}" title="All registered users' texts">Overall</button>
               </div>`
            : ""
        }
        <div class="seg-control" role="group" aria-label="Time range">
          ${(Object.keys(RANGES) as unknown as Range[])
            .map((k) => `<button data-range="${k}" aria-pressed="${String(Number(k) === range)}">${RANGES[k]}</button>`)
            .join("")}
        </div>
      </div>
    </div>
    ${tiles}
    <div class="dash-grid">
      ${topCard}${dailyCard}${langCard}${hoursCard}${voicesCard}${lastCard}
    </div>
    ${table}`;

  root.querySelectorAll<HTMLButtonElement>("[data-dash-scope]").forEach((b) =>
    b.addEventListener("click", () => {
      dashScope = b.dataset.dashScope as StatsScope;
      void renderDashboard(root);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      range = Number(b.dataset.range) as Range;
      void renderDashboard(root);
    }),
  );
}

// ---------- shared hover tooltip ----------
const tooltip = document.createElement("div");
tooltip.className = "tooltip";
tooltip.hidden = true;
document.body.appendChild(tooltip);

document.addEventListener("pointermove", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  if (!el) {
    tooltip.hidden = true;
    return;
  }
  tooltip.innerHTML = el.dataset.tip!;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, window.innerWidth - r.width - 8);
  const y = e.clientY - r.height - 12 < 8 ? e.clientY + 18 : e.clientY - r.height - 12;
  tooltip.style.transform = `translate(${x}px, ${y}px)`;
});
