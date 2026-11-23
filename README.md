# Text Voice

A small web app for saving short texts as "speech bubbles" and having them read aloud, with voice presets, Thai/English handling, and a usage dashboard.

**v2 (this branch)**: static front end on **GitHub Pages** + **Supabase** (Postgres, anonymous auth, Row Level Security). There is no server to run.
**v1**: the local edition (Node API + local PostgreSQL) is kept at the git tag [`v1-local-postgres`](../../tree/v1-local-postgres).

- **Texts**: add, edit, delete, copy and search texts; play them with ▶ Speak
- **Voice presets**: named voice + speed + pitch, assignable per text
- **Thai & English**: each text is read by a voice in its own language (detected automatically)
- **Dashboard**: most-played texts, plays per day, totals (7 days / 30 days / all time)
- **Private per visitor**: every visitor is signed in anonymously and only sees their own data
- **Themes**: Auto (follows the browser/OS), Light, Dark

Text-to-speech uses the browser's built-in [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API): no API key, no cost, using the voices installed on the visitor's device.

---

## How it works

```
Browser (GitHub Pages) ──supabase-js + anon key──▶ Supabase
                                                    ├─ Auth: anonymous sign-in (one user per browser)
                                                    ├─ Postgres: presets, texts, plays
                                                    └─ Row Level Security: user_id = auth.uid()
```

- The **anon key is public by design**. Security comes from Row Level Security (RLS) in [`supabase/schema.sql`](supabase/schema.sql): every row has a `user_id`, and visitors can only read and write rows where `user_id = auth.uid()`.
- Not signed in (`anon` role) = no access to any table.
- The dashboard numbers come from a Postgres function (`get_stats`) that also runs under RLS.

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| [Node.js](https://nodejs.org/) | **22 or newer** (developed on 24) | Building and running locally |
| A [Supabase](https://supabase.com/) project | Free tier is fine | The database |
| [PostgreSQL](https://www.postgresql.org/download/) | 14 or newer | **Only for running the tests** |
| Browser | Microsoft Edge or Google Chrome | Edge has the best Thai voices |

---

## Setup

### 1. Supabase project (once)

1. Create a project at [supabase.com](https://supabase.com/).
2. **Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".**
3. **SQL Editor → New query →** paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. It's safe to run again later.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
   Never use the `service_role` key in this app.

### 2. Run locally

```bash
git clone https://github.com/NO1R-E/text-to-voice-demo.git
cd text-to-voice-demo
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Put your values in `.env`:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
```

```bash
npm run dev
```

Open **http://localhost:5173**.

### 3. Deploy to GitHub Pages

1. **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**, and add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main`. The workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) type-checks, runs all tests, builds and deploys.
4. The site appears at `https://<your-user>.github.io/<repo-name>/`.

---

## How to use

### Texts
1. Type in the box and press **Enter** (or **Add text**). `Shift + Enter` adds a new line. Max 1,000 characters.
2. Optionally pick a **voice preset** first. With an empty box all presets are listed, grouped by language.
3. On each bubble:
   - **▶ Speak** / **■ Stop**: read it aloud (counted on the dashboard)
   - **✎ Edit**: change the text (Enter saves, Esc cancels)
   - **Copy icon**: copy the full text
   - **✕**: delete the text and its play history
   - **Show more**: expand long texts (clipped to 4 lines)
4. Use **search**, the **preset filter** and **sort** (Most played / Newest / Oldest) above the list.

### Voices & presets
Open **Voice settings & presets**:
- **Default voices**: one for Thai text and one for English text, with shared speed and pitch. **▶ Preview** plays a sample.
- **Presets**: **+ New preset**, then name it and pick a voice, speed and pitch. Presets are grouped by language. **✎ Edit** opens one; **▶ Test** plays it.

Default voices and the theme are saved per browser (localStorage). Texts, presets and plays are saved in Supabase.

### Thai & English
- Any Thai character makes a text **Thai**; everything else is **English**.
- A text only offers presets in its own language. Its **Auto** option shows the voice that will be used, for example "Auto Thai voice (Microsoft Pattara)".
- Voices in other languages are hidden.

### Dashboard
Total plays, characters spoken, saved texts, the most-played text, a top-10 chart, plays per day, and a table view. **Reset stats** deletes your play history (texts are kept).

### Status pill
Shows the Supabase connection: **Saved to database**, **Saving…**, **Last save failed**, or **Database offline**. Click it to re-check.

### "Your data" means this browser
Each browser gets its own anonymous Supabase user, stored in that browser. Clearing site data, or opening the site in another browser or device, starts a new, empty space.

---

## Thai voices

Voices come from the visitor's device:

- **Windows**: *Microsoft Pattara* (th-TH). If missing: **Settings › Time & language › Speech › Add voices › Thai**.
- **Microsoft Edge**: adds online neural Thai voices (Premwadee, Niwat).
- **Chrome**: may offer a Google Thai voice.

If Thai text exists but no Thai voice is installed, the app shows a warning.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server on http://localhost:5173 |
| `npm run build` | Type-check and build into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | Run all tests once |
| `npm run test:watch` | Re-run tests on every save |

### Tests

Tests don't touch your Supabase project. They run against a **local PostgreSQL** made to behave like Supabase:
- [`test/supabase-shim.sql`](test/supabase-shim.sql) adds the `anon` and `authenticated` roles, `auth.users` and `auth.uid()`;
- then the real [`supabase/schema.sql`](supabase/schema.sql) is applied;
- [`test/fake-supabase.ts`](test/fake-supabase.ts) stands in for `@supabase/supabase-js` and runs each request as the signed-in visitor, so RLS, constraints and SQL functions are really exercised.

Setup: put a local Postgres URL in `.env` as `DATABASE_URL`. The tests create and rebuild a separate database named `<name>_test`, and refuse to run against any database whose name doesn't end in `_test`. The first run also creates the login-less roles `anon` and `authenticated` on that Postgres server.

```bash
npm test
```

In CI, GitHub Actions starts a throwaway Postgres for this.

---

## Dependencies

| Package | Type | Used for |
|---|---|---|
| [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript) | runtime | Database queries and anonymous auth from the browser |
| `vite` | dev | Dev server and build |
| `typescript` | dev | Type checking |
| `vitest`, `jsdom` | dev | Unit and UI tests (with a fake speech engine) |
| `pg`, `@types/pg` | dev | Tests: talk to the local test database |
| `@types/node` | dev | Type definitions |

No front-end framework, no server, no paid services.

---

## Project structure

```
├── index.html               Page shell (applies the saved theme before first paint)
├── src/
│   ├── main.ts              Texts tab, presets, search/sort, status pill, theme switch
│   ├── dashboard.ts         Dashboard tab (Supabase get_stats)
│   ├── store.ts             In-memory state + ordered saves
│   ├── backend.ts           All Supabase calls (auth, tables, functions)
│   ├── tts.ts               Speech: Thai/English detection, voice choice, speaking
│   ├── theme.ts             Auto / Light / Dark
│   └── style.css
├── supabase/schema.sql      Tables, RLS policies, view, functions (paste into Supabase)
├── test/                    Vitest tests + local Supabase stand-in
├── .github/workflows/       Test + deploy to GitHub Pages
└── .env.example             Template for .env
```

### Database

| Object | What it is |
|---|---|
| `presets` | id, user_id, name, voice_uri, rate, pitch, created_at |
| `texts` | id, user_id, text, preset_id, created_at, updated_at |
| `plays` | one row per time a text is read aloud: user_id, text_id, played_at, chars, voice_uri, preset_id |
| `text_list` (view) | texts with their play counts |
| `get_stats(p_days, p_tz)` | dashboard numbers for the caller |
| `clear_plays()` | deletes the caller's play history |
| `ping()` | connection check for the status pill |

Composite foreign keys make sure a text can only use its owner's presets, and plays can only reference the player's own texts.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Supabase isn't configured" | Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` (locally) or in the GitHub secrets (Pages), then restart or redeploy |
| "Anonymous sign-ins are disabled" | Supabase → Authentication → enable anonymous sign-ins |
| `relation "public.text_list" does not exist` | Run `supabase/schema.sql` in the Supabase SQL editor |
| Pill says **Database offline** | Check your internet connection. Free Supabase projects pause after inactivity; resume yours in the Supabase dashboard |
| Pages site loads but shows a blank page | Check that Pages → Source is "GitHub Actions", and that the workflow succeeded |
| Thai text is silent or sounds wrong | Install a Thai voice, or use Microsoft Edge |
| `Port 5173 is in use` | Another dev server is running; close it |
