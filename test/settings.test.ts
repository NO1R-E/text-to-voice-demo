import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { storeIdle, synth, testPool, type FakeUtterance } from "./setup";

const settingsRows = async () =>
  (await testPool.query("select voice_th, voice_en, rate, pitch from public.user_settings")).rows;

async function seedUser(name: string, settings?: { voice_en?: string; rate?: number }) {
  const id = randomUUID();
  const email = `${name.toLowerCase()}@example.com`;
  await testPool.query(
    `insert into auth.users (id, is_anonymous, email, encrypted_password, raw_user_meta_data)
     values ($1, false, $2, 'secret123', $3)`,
    [id, email, JSON.stringify({ display_name: name })],
  );
  if (settings) {
    await testPool.query("insert into public.user_settings (user_id, voice_en, rate) values ($1, $2, $3)", [
      id,
      settings.voice_en ?? null,
      settings.rate ?? 1,
    ]);
  }
  return { email, password: "secret123" };
}

async function boot() {
  await import("../src/main");
  const { store } = await import("../src/store");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const choose = (sel: string, value: string) => {
    const s = $<HTMLSelectElement>(sel);
    s.value = value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const slide = (sel: string, value: string) => {
    const r = $<HTMLInputElement>(sel);
    r.value = value;
    r.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const lastUtterance = () => synth.speak.mock.calls.at(-1)![0] as FakeUtterance;
  return { $, store, choose, slide, lastUtterance };
}
/** Reload the page in the same browser (keeps the session, drops in-memory state). */
async function reloadPage() {
  await storeIdle();
  vi.resetModules();
  document.body.innerHTML = `<div id="app"></div>`;
  return boot();
}

describe("default voices are saved per account", () => {
  it("saves changes to the account in Supabase", async () => {
    const ui = await boot();
    ui.choose("#voice-en", "voice-b");
    ui.slide("#rate", "1.4");
    await ui.store.whenIdle();
    expect(await settingsRows()).toEqual([{ voice_th: null, voice_en: "voice-b", rate: 1.4, pitch: 1 }]);
  });

  it("loads them from the account, not the browser", async () => {
    let ui = await boot();
    ui.choose("#voice-en", "voice-b");
    ui.slide("#pitch", "1.3");
    await ui.store.whenIdle();
    localStorage.removeItem("task-voice:settings"); // prove it comes from Supabase
    ui = await reloadPage();
    expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-b");
    expect(ui.$<HTMLInputElement>("#pitch").value).toBe("1.3");
    expect(ui.$("#pitch-v").textContent).toBe("1.3");
  });

  it("signing in switches to that account's defaults (and they're used to speak)", async () => {
    const bo = await seedUser("Bo", { voice_en: "voice-b", rate: 1.5 });
    const ui = await boot();
    ui.$<HTMLButtonElement>("#open-signin").click();
    ui.$<HTMLInputElement>("#auth-email").value = bo.email;
    ui.$<HTMLInputElement>("#auth-password").value = bo.password;
    ui.$<HTMLFormElement>("#auth-form").requestSubmit();
    await vi.waitFor(() => expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-b"));
    expect(ui.$<HTMLInputElement>("#rate").value).toBe("1.5");

    ui.store.addText("hello");
    ui.$<HTMLButtonElement>('[data-act="speak"]').click();
    expect(ui.lastUtterance().lang).toBe("en-GB");
    expect(ui.lastUtterance().rate).toBe(1.5);
  });

  it("signing out starts a fresh guest with standard defaults", async () => {
    const bo = await seedUser("Bo", { voice_en: "voice-b", rate: 1.5 });
    const ui = await boot();
    await ui.store.signIn(bo.email, bo.password);
    await vi.waitFor(() => expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-b"));
    await ui.store.signOut();
    await vi.waitFor(() => expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-a"));
    expect(ui.$<HTMLInputElement>("#rate").value).toBe("1");
  });

  it("copies the defaults this browser already had into the account, once", async () => {
    localStorage.setItem("task-voice:settings", JSON.stringify({ voices: { en: "voice-b" }, rate: 1.3, pitch: 1 }));
    const ui = await boot();
    await ui.store.whenIdle();
    expect(await settingsRows()).toEqual([{ voice_th: null, voice_en: "voice-b", rate: 1.3, pitch: 1 }]);
    expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-b");
  });

  it("an account's saved defaults win over the browser's old ones", async () => {
    const bo = await seedUser("Bo", { voice_en: "voice-a", rate: 0.8 });
    localStorage.setItem("task-voice:settings", JSON.stringify({ voices: { en: "voice-b" }, rate: 1.9, pitch: 1 }));
    const ui = await boot();
    await ui.store.signIn(bo.email, bo.password);
    await vi.waitFor(() => expect(ui.$<HTMLInputElement>("#rate").value).toBe("0.8"));
    expect(ui.$<HTMLSelectElement>("#voice-en").value).toBe("voice-a");
  });
});

describe("user_settings security", () => {
  it("each user can only see and change their own defaults", async () => {
    const a = await seedUser("Ada", { voice_en: "voice-a", rate: 1 });
    void a;
    const b = await seedUser("Bo");
    const { rows } = await testPool.query("select id from auth.users where email = 'bo@example.com'");
    const bid = rows[0].id;
    const c = await testPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: bid })]);
      await c.query("set local role authenticated");
      expect((await c.query("select * from public.user_settings")).rows).toEqual([]);
      await c.query("update public.user_settings set rate = 9");
      await c.query("commit");
    } finally {
      c.release();
    }
    expect((await testPool.query("select rate from public.user_settings")).rows).toEqual([{ rate: 1 }]);
    void b;
  });
});
