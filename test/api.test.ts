// @vitest-environment node
import { describe, expect, it } from "vitest";
import "./setup";

async function call<T = any>(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json();
  return { status: res.status, data: data as T };
}

const state = async () => (await call("GET", "/state")).data;
const DAY = 86_400_000;

describe("API: health", () => {
  it("reports the database it's connected to", async () => {
    const { status, data } = await call("GET", "/health");
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, database: "task-voice_test" });
    expect(typeof data.latencyMs).toBe("number");
  });
});

describe("API: texts", () => {
  it("starts empty", async () => {
    expect(await state()).toEqual({ texts: [], presets: [] });
  });

  it("creates, edits and deletes a text", async () => {
    const id = crypto.randomUUID();
    const created = await call("POST", "/texts", { id, text: "  hello  " });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ id, text: "hello", plays: 0 });

    const edited = await call("PATCH", `/texts/${id}`, { text: "hi" });
    expect(edited.data.text).toBe("hi");

    expect((await call("DELETE", `/texts/${id}`)).status).toBe(204);
    expect((await state()).texts).toEqual([]);
  });

  it("generates an id when none is given and lists newest first", async () => {
    await call("POST", "/texts", { text: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await call("POST", "/texts", { text: "second" });
    expect((await state()).texts.map((t: any) => t.text)).toEqual(["second", "first"]);
  });

  it("rejects bad input", async () => {
    expect((await call("POST", "/texts", { text: "   " })).status).toBe(400);
    expect((await call("POST", "/texts", { text: 5 })).status).toBe(400);
    expect((await call("POST", "/texts", { text: "x", presetId: "nope" })).status).toBe(400);
    expect((await call("PATCH", `/texts/${crypto.randomUUID()}`, { text: "x" })).status).toBe(404);
    expect((await call("PATCH", "/texts/not-a-uuid", { text: "x" })).status).toBe(404);
  });
});

describe("API: presets", () => {
  it("creates, updates and deletes presets; deleting one un-assigns texts", async () => {
    const pid = crypto.randomUUID();
    const p = await call("POST", "/presets", { id: pid, name: "Slow", voiceURI: "voice-a", rate: 0.5, pitch: 1 });
    expect(p.status).toBe(201);
    expect(p.data).toEqual({ id: pid, name: "Slow", voiceURI: "voice-a", rate: 0.5, pitch: 1 });

    const tid = crypto.randomUUID();
    await call("POST", "/texts", { id: tid, text: "x", presetId: pid });
    await call("PATCH", `/presets/${pid}`, { rate: 1.7, name: "Fast" });
    let s = await state();
    expect(s.presets[0]).toMatchObject({ name: "Fast", rate: 1.7 });
    expect(s.texts[0].presetId).toBe(pid);

    await call("DELETE", `/presets/${pid}`);
    s = await state();
    expect(s.presets).toEqual([]);
    expect(s.texts[0].presetId).toBeUndefined();
  });

  it("rejects out-of-range settings", async () => {
    expect((await call("POST", "/presets", { name: "x", rate: 99, pitch: 1 })).status).toBe(400);
    expect((await call("POST", "/presets", { name: "", rate: 1, pitch: 1 })).status).toBe(400);
  });

  it("can un-assign a text's preset with null", async () => {
    const pid = crypto.randomUUID();
    await call("POST", "/presets", { id: pid, name: "P", rate: 1, pitch: 1 });
    const tid = crypto.randomUUID();
    await call("POST", "/texts", { id: tid, text: "x", presetId: pid });
    await call("PATCH", `/texts/${tid}`, { presetId: null });
    expect((await state()).texts[0].presetId).toBeUndefined();
  });
});

describe("API: plays & dashboard stats", () => {
  async function textWithPlays(text: string, n: number) {
    const id = crypto.randomUUID();
    await call("POST", "/texts", { id, text });
    for (let i = 0; i < n; i++) await call("POST", `/texts/${id}/plays`, { chars: text.length, voiceURI: "voice-a" });
    return id;
  }

  it("counts plays per text in the state", async () => {
    const id = await textWithPlays("abc", 2);
    expect((await state()).texts.find((t: any) => t.id === id).plays).toBe(2);
  });

  it("404s a play for a missing text", async () => {
    expect((await call("POST", `/texts/${crypto.randomUUID()}/plays`, { chars: 1 })).status).toBe(404);
  });

  it("deleting a text deletes its plays", async () => {
    const id = await textWithPlays("abc", 3);
    await call("DELETE", `/texts/${id}`);
    expect((await call("GET", "/stats?days=0&tz=UTC")).data.totals.plays).toBe(0);
  });

  it("ranks most played texts with totals and a daily series", async () => {
    await textWithPlays("rare", 1);
    await textWithPlays("popular", 3);
    const { data } = await call("GET", "/stats?days=7&tz=Asia/Bangkok");
    expect(data.totals).toEqual({ plays: 4, chars: 4 + 21, texts: 2 });
    expect(data.top.map((t: any) => [t.text, t.plays])).toEqual([
      ["popular", 3],
      ["rare", 1],
    ]);
    expect(data.daily).toHaveLength(7);
    expect(data.daily.at(-1).plays).toBe(4);
    expect(data.daily.at(-1).day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("filters stats by range", async () => {
    const id = crypto.randomUUID();
    await call("POST", "/import", {
      texts: [{ id, text: "old", createdAt: Date.now() - 60 * DAY }],
      plays: [{ taskId: id, at: Date.now() - 40 * DAY, chars: 3 }],
    });
    await call("POST", `/texts/${id}/plays`, { chars: 3 });
    expect((await call("GET", "/stats?days=30&tz=UTC")).data.totals.plays).toBe(1);
    expect((await call("GET", "/stats?days=0&tz=UTC")).data.totals.plays).toBe(2);
  });

  it("rejects a bad range or time zone", async () => {
    expect((await call("GET", "/stats?days=-1&tz=UTC")).status).toBe(400);
    expect((await call("GET", "/stats?days=7&tz=Not/AZone")).status).toBe(400);
  });

  it("resets all play history", async () => {
    await textWithPlays("abc", 2);
    expect((await call("DELETE", "/plays")).status).toBe(204);
    const s = await state();
    expect(s.texts[0].plays).toBe(0); // text itself is kept
  });
});

describe("API: import of old browser data", () => {
  const legacy = () => {
    const pid = crypto.randomUUID();
    const tid = crypto.randomUUID();
    return {
      presets: [{ id: pid, name: "Thai", voiceURI: "voice-th", rate: 0.9, pitch: 1 }],
      texts: [{ id: tid, text: "สวัสดี", createdAt: Date.now() - DAY, presetId: pid, done: true }],
      plays: [
        { taskId: tid, at: Date.now() - 1000, chars: 6 },
        { taskId: crypto.randomUUID(), at: Date.now(), chars: 1 }, // orphan: skipped
      ],
    };
  };

  it("imports presets, texts and plays, skipping orphans", async () => {
    const data = legacy();
    const res = await call("POST", "/import", data);
    expect(res.data).toEqual({ presets: 1, texts: 1, plays: 1 });
    const s = await state();
    expect(s.texts[0]).toMatchObject({ text: "สวัสดี", presetId: data.presets[0].id, plays: 1 });
    expect(s.presets[0].name).toBe("Thai");
  });

  it("doesn't duplicate texts or presets when run twice", async () => {
    const data = legacy();
    await call("POST", "/import", data);
    await call("POST", "/import", { presets: data.presets, texts: data.texts });
    const s = await state();
    expect(s.texts).toHaveLength(1);
    expect(s.presets).toHaveLength(1);
  });
});
