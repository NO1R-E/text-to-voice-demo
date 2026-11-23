# Text Voice

A small local web app for saving short texts as "speech bubbles" and having them read aloud, with voice presets, Thai/English handling, and a usage dashboard. Data is stored in PostgreSQL.

- **Texts tab**: add, edit, delete, copy and search texts; play them with ▶ Speak
- **Voice presets**: named voice + speed + pitch, assignable per text
- **Thai & English**: each text is read by a voice in its own language (detected automatically)
- **Dashboard**: most-played texts, plays per day, totals (7 days / 30 days / all time)
- **Themes**: Auto (follows the browser/OS), Light, Dark

Text-to-speech uses the browser's built-in [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API): no API key, no cost, works offline with the voices installed on your system.

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | **22 or newer** (developed on 24) | Includes `npm` |
| [PostgreSQL](https://www.postgresql.org/download/) | **14 or newer** (developed on 18) | Running locally |
| Browser | Microsoft Edge or Google Chrome | Edge has the best Thai voices |
| Thai voice (optional) | Any `th-TH` voice | See [Thai voices](#thai-voices) |

---

## Installation

### 1. Clone and install packages

```bash
git clone https://github.com/NO1R-E/text-to-voice-demo.git
cd text-to-voice-demo
npm install
```

### 2. Create the database

Create an empty database (the name can be anything; this README uses `task-voice`):

```bash
psql -U postgres -c "CREATE DATABASE \"task-voice\";"
```

On Windows, if `psql` isn't on your PATH, use the full path, for example
`"C:\Program Files\PostgreSQL\18\bin\psql.exe"`, or create the database in pgAdmin.

You don't need to create tables: the API creates them automatically on startup.

### 3. Configure the connection

Copy the example file and put in your own Postgres password:

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/task-voice
```

If the password contains `@ : / #`, URL-encode it (for example `@` → `%40`).
`.env` is git-ignored: never commit it.

### 4. Run

```bash
npm run dev
```

This starts both parts:

```
[web] ➜ Local: http://localhost:5173/
[api] API ready on http://127.0.0.1:8787 (database "task-voice")
```

Open **http://localhost:5173**. Press `Ctrl + C` to stop both.

---

## How to use

### Texts
1. Type in the box and press **Enter** (or **Add text**). `Shift + Enter` adds a new line. Max 1,000 characters.
2. Optionally pick a **voice preset** in the dropdown before adding.
3. On each bubble:
   - **▶ Speak** / **■ Stop**: read it aloud (each play is counted for the dashboard)
   - **✎ Edit**: change the text (Enter saves, Esc cancels)
   - **Copy icon**: copy the full text
   - **✕**: delete the text and its play history
   - **Show more**: expand long texts (clipped to 4 lines)
4. Use **search**, the **preset filter** and **sort** (Most played / Newest / Oldest) above the list.

### Voices & presets
Open **Voice settings & presets**:
- **Default voices**: one for Thai text and one for English text, with shared speed and pitch. **▶ Preview** plays a sample.
- **Presets**: **+ New preset**, then name it and pick a voice, speed and pitch. Presets are grouped by language. **✎ Edit** opens a preset; **▶ Test** plays it.

### Thai & English
- Any Thai character makes a text **Thai**; everything else is **English**.
- A text only offers presets in its own language. Its **Auto** option shows the voice that will be used, for example "Auto Thai voice (Microsoft Pattara)".
- Voices in other languages are hidden.

### Dashboard
Shows total plays, characters spoken, saved texts, the most-played text, a top-10 chart, plays per day, and a table view. **Reset stats** deletes play history (texts are kept).

### Status pill
The pill above the add box shows the database connection: **Saved to database**, **Saving…**, **Last save failed**, or **Database offline**. Click it to re-check.

### Moving data from older versions
Earlier versions stored data in the browser (localStorage). The first time a browser opens this version, that data is imported into Postgres once; the browser copy is kept as a backup.

---

## Thai voices

Which voices you have depends on your OS and browser:

- **Windows**: *Microsoft Pattara* (th-TH). If missing: **Settings › Time & language › Speech › Add voices › Thai**.
- **Microsoft Edge**: adds online neural Thai voices (Premwadee, Niwat).
- **Chrome**: may offer a Google Thai voice.

If Thai text exists but no Thai voice is installed, the app shows a warning.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Website (port 5173) + API (port 8787) together, with auto-reload |
| `npm run dev:web` | Website only |
| `npm run dev:api` | API only |
| `npm test` | Run all tests once |
| `npm run test:watch` | Re-run tests on every save |
| `npm run build` | Type-check and build the website into `dist/` |

### Tests

```bash
npm test
```

Tests run against a **separate database** named after yours plus `_test` (for example `task-voice_test`). It is created automatically. The test setup refuses to wipe any database whose name doesn't end in `_test`, so your real data is never touched. Postgres must be running.

---

## Dependencies

**Runtime**

| Package | Used for |
|---|---|
| [`hono`](https://hono.dev/) | API routes (`server/app.ts`) |
| [`@hono/node-server`](https://github.com/honojs/node-server) | Runs the Hono API on Node |
| [`pg`](https://node-postgres.com/) | PostgreSQL client |

**Development**

| Package | Used for |
|---|---|
| `vite` | Dev server and build for the website; forwards `/api` requests to the API |
| `typescript` | Type checking |
| `tsx` | Runs the TypeScript API directly, with watch mode |
| `concurrently` | Runs website + API with one command |
| `vitest`, `jsdom` | Unit and UI tests (with a fake speech engine) |
| `@types/node`, `@types/pg` | Type definitions |

No front-end framework and no paid services.

---

## Project structure

```
├── index.html            Page shell (applies the saved theme before first paint)
├── src/                  Front end (TypeScript, no framework)
│   ├── main.ts           Texts tab, presets, search/sort, status pill, theme switch
│   ├── dashboard.ts      Dashboard tab (reads /api/stats)
│   ├── store.ts          In-memory state + ordered saves to the API
│   ├── tts.ts            Speech: Thai/English detection, voice choice, speaking
│   ├── api.ts            fetch wrapper + types
│   ├── theme.ts          Auto / Light / Dark
│   └── style.css
├── server/               API (Node + Hono + pg)
│   ├── index.ts          Entry point: loads .env, creates tables, listens on 127.0.0.1:8787
│   ├── app.ts            Routes and validation
│   └── db.ts             Schema (presets, texts, plays)
├── test/                 Vitest tests (API, store, UI, Thai/English, dashboard…)
├── .env.example          Template for .env
└── vite.config.ts        Proxies /api → http://127.0.0.1:8787
```

### Database tables

| Table | Holds |
|---|---|
| `texts` | id, text, preset_id, created_at, updated_at |
| `presets` | id, name, voice_uri, rate, pitch, created_at |
| `plays` | one row per time a text is read aloud: text_id, played_at, chars, voice_uri, preset_id |

### API

All under `/api`. The API only listens on `127.0.0.1` (this computer).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Database reachable? Returns database name and latency |
| GET | `/state` | All texts (with play counts) and presets |
| POST / PATCH / DELETE | `/texts`, `/texts/:id` | Create / edit / delete a text |
| POST / PATCH / DELETE | `/presets`, `/presets/:id` | Create / edit / delete a preset |
| POST | `/texts/:id/plays` | Record a play |
| DELETE | `/plays` | Reset play history |
| GET | `/stats?days=7\|30\|0&tz=Asia/Bangkok` | Dashboard numbers |
| POST | `/import` | One-time import of old browser data |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Port 5173 is in use` | Another dev server is running. Close it, or find it with `netstat -ano \| findstr :5173` |
| Pill says **Database offline** | Is `npm run dev` running? Is Postgres running? Check `DATABASE_URL` in `.env` |
| `password authentication failed` | Wrong user or password in `DATABASE_URL` |
| `database "…" does not exist` | Create it (step 2 of Installation) |
| Thai text is silent or sounds wrong | Install a Thai voice, or use Microsoft Edge |
| No sound at all | Check system volume; some browsers need a click on the page before speaking |
