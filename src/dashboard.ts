import { getStats, type Stats, type StatsScope } from "./backend";
import { store } from "./store";
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

/** "2026-11-23" → Date at local midnight. */
function localDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const fmtDay = (day: string) => localDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function truncate(s: string, n = 48): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Fetches stats from Postgres (after pending saves land) and draws the dashboard. */
export async function renderDashboard(root: HTMLElement): Promise<void> {
  const token = ++renderToken;
  if (!root.hasChildNodes()) root.innerHTML = `<p class="muted">Loading…</p>`;

  let s: Stats;
  try {
    await store.whenIdle();
    if (!store.registered) dashScope = "mine"; // overall is for registered users
    s = await getStats(range, tz, dashScope);
  } catch (e) {
    if (token === renderToken) {
      root.innerHTML = `<p class="notice" role="alert">Couldn't load dashboard data from the database: ${esc(
        e instanceof Error ? e.message : String(e),
      )}</p>`;
    }
    return;
  }
  if (token !== renderToken) return; // a newer render is on its way

  const top = s.top.slice(0, 10);
  const maxPlays = top[0]?.plays ?? 0;
  const maxDaily = Math.max(1, ...s.daily.map((d) => d.plays));
  const most = s.top[0];
  const overall = dashScope === "overall";
  const by = (author?: string | null) => (overall && author ? ` · by ${esc(author)}` : "");

  root.innerHTML = `
    <div class="dash-head">
      <h2>Usage</h2>
      ${
        store.registered
          ? `<div class="filters" role="group" aria-label="Whose texts">
               <button data-dash-scope="mine" aria-pressed="${String(!overall)}" title="Your texts, played by anyone">Mine</button>
               <button data-dash-scope="overall" aria-pressed="${String(overall)}" title="All registered users' texts">Overall</button>
             </div>`
          : ""
      }
      <div class="filters" role="group" aria-label="Time range">
        ${(Object.keys(RANGES) as unknown as Range[])
          .map((k) => `<button data-range="${k}" aria-pressed="${String(Number(k) === range)}">${RANGES[k]}</button>`)
          .join("")}
      </div>
    </div>

    <div class="tiles">
      <div class="tile"><span class="label">Times read aloud</span><span class="value" data-stat="plays">${s.totals.plays}</span></div>
      <div class="tile"><span class="label">Characters spoken</span><span class="value" data-stat="chars">${s.totals.chars.toLocaleString()}</span></div>
      <div class="tile"><span class="label">${overall ? "Shared texts" : "Saved texts"}</span><span class="value" data-stat="texts">${s.totals.texts}</span></div>
      <div class="tile wide"><span class="label">Most played</span>
        <span class="value text">${most ? esc(truncate(most.text, 60)) : "—"}</span>
        ${most ? `<span class="muted">${plural(most.plays, "play")}${by(most.author)}</span>` : ""}
      </div>
    </div>

    <div class="card">
      <h3>${overall ? "Best texts overall" : "Most played texts"}</h3>
      <p class="sub">${overall ? "All registered users' texts, played by anyone" : "Your texts, played by anyone"} · top ${Math.min(10, s.top.length) || 10}</p>
      ${
        top.length
          ? `<div class="hbars">${top
              .map(
                (r, i) => `
              <div class="hbar-row" data-tip="<b>${esc(esc(truncate(r.text, 80)))}</b><br>${plural(r.plays, "play")}${by(r.author)} · last ${fmtDate(r.lastPlayed)}">
                <span class="hbar-label">${esc(truncate(r.text, 36))}</span>
                <span class="hbar-track">
                  <span class="hbar" style="width:${(r.plays / maxPlays) * 100}%"></span>
                  ${i === 0 ? `<span class="hbar-val">${r.plays}</span>` : ""}
                </span>
              </div>`,
              )
              .join("")}</div>`
          : `<p class="empty">No plays in this range yet. Press ▶ Speak on a text.</p>`
      }
    </div>

    <div class="card">
      <h3>Plays per day</h3>
      <p class="sub">${fmtDay(s.range.start)} – ${fmtDay(s.range.end)}</p>
      <div class="cols-wrap">
        <div class="cols" style="--n:${s.daily.length}">
          ${s.daily
            .map(
              (d) => `
            <div class="col-hit" data-tip="<b>${fmtDay(d.day)}</b><br>${plural(d.plays, "play")}">
              <span class="col" style="height:${(d.plays / maxDaily) * 100}%"></span>
            </div>`,
            )
            .join("")}
        </div>
        <div class="cols-axis"><span>${fmtDay(s.range.start)}</span><span>Today</span></div>
      </div>
    </div>

    <details class="card">
      <summary>Table view</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Text</th>${overall ? "<th>Author</th>" : ""}<th class="num">Plays</th><th class="num">Chars spoken</th><th>Last played</th></tr></thead>
          <tbody>
            ${
              s.top.length
                ? s.top
                    .map(
                      (r) => `<tr><td>${esc(truncate(r.text, 80))}</td>${overall ? `<td>${esc(r.author ?? "")}</td>` : ""}<td class="num">${r.plays}</td>
                        <td class="num">${r.chars.toLocaleString()}</td><td>${new Date(r.lastPlayed).toLocaleString()}</td></tr>`,
                    )
                    .join("")
                : `<tr><td colspan="${overall ? 5 : 4}" class="muted">No data</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </details>

    <div class="reset"><button id="clear-stats" class="ghost danger">Reset stats</button><span id="confirm-reset" hidden>
      Delete all play history from the database? <button id="confirm-yes" class="danger-solid">Yes, reset</button>
      <button id="confirm-no" class="ghost">Cancel</button></span></div>
  `;

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
  const confirmBox = root.querySelector<HTMLElement>("#confirm-reset")!;
  root.querySelector("#clear-stats")!.addEventListener("click", () => (confirmBox.hidden = false));
  root.querySelector("#confirm-no")!.addEventListener("click", () => (confirmBox.hidden = true));
  root.querySelector("#confirm-yes")!.addEventListener("click", () => store.clearStats());
}

// ---------- shared hover tooltip ----------
const tip = document.createElement("div");
tip.className = "tooltip";
tip.hidden = true;
document.body.appendChild(tip);

document.addEventListener("pointermove", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
  if (!el) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = el.dataset.tip!;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(e.clientX + 14, window.innerWidth - r.width - 8);
  const y = e.clientY - r.height - 12 < 8 ? e.clientY + 18 : e.clientY - r.height - 12;
  tip.style.transform = `translate(${x}px, ${y}px)`;
});
