import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { synth, testPool, type FakeUtterance } from "./setup";

/** A registered author with optional default voices and texts (optionally with a preset). */
async function seedAuthor(
  name: string,
  opts: {
    defaults?: { voice_th?: string; voice_en?: string; rate?: number; pitch?: number };
    preset?: { name: string; voice_uri: string; rate: number; pitch: number };
    texts: { text: string; usePreset?: boolean }[];
  },
) {
  const id = randomUUID();
  await testPool.query(
    `insert into auth.users (id, is_anonymous, email, encrypted_password, raw_user_meta_data)
     values ($1, false, $2, 'secret123', $3)`,
    [id, `${name.toLowerCase()}@example.com`, JSON.stringify({ display_name: name })],
  );
  if (opts.defaults) {
    const d = opts.defaults;
    await testPool.query(
      "insert into public.user_settings (user_id, voice_th, voice_en, rate, pitch) values ($1, $2, $3, $4, $5)",
      [id, d.voice_th ?? null, d.voice_en ?? null, d.rate ?? 1, d.pitch ?? 1],
    );
  }
  let presetId: string | null = null;
  if (opts.preset) {
    const p = opts.preset;
    const { rows } = await testPool.query(
      "insert into public.presets (user_id, name, voice_uri, rate, pitch) values ($1, $2, $3, $4, $5) returning id",
      [id, p.name, p.voice_uri, p.rate, p.pitch],
    );
    presetId = rows[0].id;
  }
  for (const t of opts.texts) {
    await testPool.query("insert into public.texts (user_id, text, preset_id) values ($1, $2, $3)", [
      id,
      t.text,
      t.usePreset ? presetId : null,
    ]);
  }
}

async function listenerBoot(listenerDefaults?: { voice_en?: string }) {
  await import("../src/main");
  const { store } = await import("../src/store");
  await store.signUp("Bo", "bo@example.com", "secret123");
  if (listenerDefaults?.voice_en) {
    store.updateDefaults({ voices: { en: listenerDefaults.voice_en } });
    await store.whenIdle();
  }
  await store.setScope("everyone");
  const bubble = (text: string) =>
    [...document.querySelectorAll<HTMLElement>(".bubble")].find((b) => b.querySelector(".text")?.textContent === text)!;
  await vi.waitFor(() => expect(document.querySelectorAll(".bubble.others").length).toBeGreaterThan(0));
  const play = (text: string) => {
    bubble(text).querySelector<HTMLButtonElement>('[data-act="speak"]')!.click();
    return synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  };
  return { store, bubble, play };
}

describe("others hear the owner's voice", () => {
  it("a text with a preset plays with the owner's preset", async () => {
    await seedAuthor("Ada", {
      preset: { name: "Calm", voice_uri: "voice-b", rate: 1.6, pitch: 0.8 },
      texts: [{ text: "with preset", usePreset: true }],
    });
    const ui = await listenerBoot();
    const u = ui.play("with preset");
    expect([u.lang, u.rate, u.pitch]).toEqual(["en-GB", 1.6, 0.8]);
    expect(ui.bubble("with preset").querySelector(".voice-info")!.textContent).toMatch(/Ada's preset “Calm”/);
  });

  it("an Auto text plays with the owner's default voice for that language", async () => {
    await seedAuthor("Ada", {
      defaults: { voice_th: "voice-th", voice_en: "voice-b", rate: 0.7, pitch: 1.2 },
      texts: [{ text: "auto english" }, { text: "สวัสดี" }],
    });
    const ui = await listenerBoot();
    let u = ui.play("auto english");
    expect([u.lang, u.rate, u.pitch]).toEqual(["en-GB", 0.7, 1.2]);
    u = ui.play("สวัสดี");
    expect([u.lang, u.rate]).toEqual(["th-TH", 0.7]);
    expect(ui.bubble("auto english").querySelector(".voice-info")!.textContent).toMatch(/Ada's default voice/);
  });

  it("an owner without saved defaults plays at standard speed with the listener's voice", async () => {
    await seedAuthor("Ada", { texts: [{ text: "plain" }] });
    const ui = await listenerBoot({ voice_en: "voice-b" });
    const u = ui.play("plain");
    expect([u.lang, u.rate, u.pitch]).toEqual(["en-GB", 1, 1]);
  });

  it("if the owner's voice isn't on this device, uses the listener's voice with the owner's speed", async () => {
    await seedAuthor("Ada", {
      preset: { name: "Rare", voice_uri: "voice-not-installed", rate: 1.3, pitch: 1 },
      texts: [{ text: "rare voice", usePreset: true }],
    });
    const ui = await listenerBoot({ voice_en: "voice-b" });
    const u = ui.play("rare voice");
    expect([u.lang, u.rate]).toEqual(["en-GB", 1.3]);
    expect(ui.bubble("rare voice").querySelector(".voice-info")!.getAttribute("title")).toMatch(/not on this device/);
  });

  it("the owner still hears their own texts as before", async () => {
    await import("../src/main");
    const { store } = await import("../src/store");
    const pid = store.addPreset({ name: "Mine", voiceURI: "voice-b", rate: 1.8, pitch: 1 });
    store.addText("my text", pid);
    document.querySelector<HTMLButtonElement>('[data-act="speak"]')!.click();
    const u = synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
    expect([u.lang, u.rate]).toEqual(["en-GB", 1.8]);
  });
});

describe("list_texts exposes how a shared text should sound", () => {
  it("returns preset or default playback settings", async () => {
    await seedAuthor("Ada", {
      defaults: { voice_th: "voice-th", voice_en: "voice-a", rate: 0.9 },
      preset: { name: "Calm", voice_uri: "voice-b", rate: 1.6, pitch: 0.8 },
      texts: [{ text: "p", usePreset: true }, { text: "en auto" }, { text: "ไทย" }],
    });
    const viewer = randomUUID();
    await testPool.query(
      `insert into auth.users (id, is_anonymous, email, raw_user_meta_data) values ($1, false, 'v@example.com', '{"display_name":"V"}')`,
      [viewer],
    );
    const c = await testPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer })]);
      await c.query("set local role authenticated");
      const { rows } = await c.query(
        "select text, play_source, play_preset, play_voice, play_rate, play_pitch from public.list_texts('everyone') order by text",
      );
      await c.query("commit");
      expect(rows).toEqual([
        { text: "en auto", play_source: "default", play_preset: null, play_voice: "voice-a", play_rate: 0.9, play_pitch: 1 },
        { text: "p", play_source: "preset", play_preset: "Calm", play_voice: "voice-b", play_rate: 1.6, play_pitch: 0.8 },
        { text: "ไทย", play_source: "default", play_preset: null, play_voice: "voice-th", play_rate: 0.9, play_pitch: 1 },
      ]);
    } finally {
      c.release();
    }
  });
});
