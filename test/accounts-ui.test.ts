import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testPool } from "./setup";

/** A registered user that already exists (e.g. signed up on another device). */
async function seedUser(name: string, texts: string[] = [], playsEach = 0) {
  const id = randomUUID();
  const email = `${name.toLowerCase()}@example.com`;
  await testPool.query(
    `insert into auth.users (id, is_anonymous, email, encrypted_password, raw_user_meta_data)
     values ($1, false, $2, 'secret123', $3)`,
    [id, email, JSON.stringify({ display_name: name })],
  );
  for (const text of texts) {
    const { rows } = await testPool.query("insert into public.texts (user_id, text) values ($1, $2) returning id", [
      id,
      text,
    ]);
    for (let i = 0; i < playsEach; i++) {
      await testPool.query("insert into public.plays (user_id, text_id, chars) values ($1, $2, 3)", [id, rows[0].id]);
    }
  }
  return { id, email, password: "secret123" };
}

async function boot() {
  await import("../src/main");
  const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  const texts = () => [...document.querySelectorAll(".bubble .text")].map((e) => e.textContent);
  const bubble = (text: string) =>
    [...document.querySelectorAll<HTMLElement>(".bubble")].find((b) => b.querySelector(".text")?.textContent === text)!;
  const add = (text: string) => {
    $<HTMLTextAreaElement>("#new-text").value = text;
    $<HTMLFormElement>("#add-form").requestSubmit();
  };
  const fill = (fields: Record<string, string>) => {
    for (const [id, v] of Object.entries(fields)) $<HTMLInputElement>(`#${id}`).value = v;
  };
  const signUp = async (name: string, email: string, password: string) => {
    $<HTMLButtonElement>("#open-signup").click();
    fill({ "auth-name": name, "auth-email": email, "auth-password": password });
    $<HTMLFormElement>("#auth-form").requestSubmit();
  };
  const signIn = (email: string, password: string) => {
    $<HTMLButtonElement>("#open-signin").click();
    fill({ "auth-email": email, "auth-password": password });
    $<HTMLFormElement>("#auth-form").requestSubmit();
  };
  const signedInAs = (name: string) =>
    vi.waitFor(() => expect(document.querySelector(".account-name")?.textContent).toBe(name));
  return { $, texts, bubble, add, signUp, signIn, signedInAs };
}

describe("anonymous visitor", () => {
  it("sees Sign up / Sign in, but no Everyone view or Overall stats", async () => {
    const ui = await boot();
    expect(ui.$("#open-signup")).not.toBeNull();
    expect(ui.$("#open-signin")).not.toBeNull();
    expect(ui.$<HTMLElement>("#scope").hidden).toBe(true);
    ui.$<HTMLButtonElement>('[data-tab="dashboard"]').click();
    await vi.waitFor(() => expect(document.querySelector("[data-stat]")).not.toBeNull());
    expect(document.querySelector('[data-dash-scope="overall"]')).toBeNull();
  });
});

describe("sign up", () => {
  it("upgrades the visitor in place and keeps their texts", async () => {
    const ui = await boot();
    ui.add("keep me");
    await ui.signUp("Ada", "ada@example.com", "secret123");
    await ui.signedInAs("Ada");
    expect(ui.texts()).toEqual(["keep me"]);
    const { rows } = await testPool.query(
      "select u.is_anonymous, p.display_name from auth.users u join public.profiles p on p.id = u.id",
    );
    expect(rows).toEqual([{ is_anonymous: false, display_name: "Ada" }]);
    expect(ui.$<HTMLElement>("#auth-panel").hidden).toBe(true);
  });

  it("checks the password before changing anything", async () => {
    const ui = await boot();
    await ui.signUp("Ada", "ada@example.com", "123");
    await vi.waitFor(() => expect(ui.$("#auth-error").textContent).toMatch(/at least 6/));
    const { rows } = await testPool.query("select is_anonymous from auth.users");
    expect(rows).toEqual([{ is_anonymous: true }]);
  });

  it("shows Supabase's error when the email is taken", async () => {
    const bo = await seedUser("Bo");
    const ui = await boot();
    await ui.signUp("Ada", bo.email, "secret123");
    await vi.waitFor(() => expect(ui.$("#auth-error").textContent).toMatch(/already been registered/));
  });
});

describe("sign in / sign out", () => {
  it("signs in to an existing account and loads its texts", async () => {
    const bo = await seedUser("Bo", ["Bo's line"]);
    const ui = await boot();
    ui.signIn(bo.email, bo.password);
    await ui.signedInAs("Bo");
    await vi.waitFor(() => expect(ui.texts()).toEqual(["Bo's line"]));
  });

  it("warns that anonymous texts stay behind when signing in", async () => {
    const ui = await boot();
    ui.add("guest note");
    ui.$<HTMLButtonElement>("#open-signin").click();
    expect(ui.$("#auth-warning").textContent).toMatch(/1 text/);
  });

  it("rejects a wrong password", async () => {
    const bo = await seedUser("Bo");
    const ui = await boot();
    ui.signIn(bo.email, "wrong-pass");
    await vi.waitFor(() => expect(ui.$("#auth-error").textContent).toMatch(/Invalid login/));
  });

  it("signing out returns to a fresh anonymous space", async () => {
    const bo = await seedUser("Bo", ["Bo's line"]);
    const ui = await boot();
    ui.signIn(bo.email, bo.password);
    await ui.signedInAs("Bo");
    ui.$<HTMLButtonElement>("#sign-out").click();
    await vi.waitFor(() => expect(document.querySelector("#open-signup")).not.toBeNull());
    expect(ui.texts()).toEqual([]);
  });
});

describe("Mine / Everyone", () => {
  it("registered users can browse others' texts read-only, with the author", async () => {
    await seedUser("Bo", ["Bo's line"]);
    const ui = await boot();
    ui.add("Ada's line");
    await ui.signUp("Ada", "ada@example.com", "secret123");
    await ui.signedInAs("Ada");
    expect(ui.$<HTMLElement>("#scope").hidden).toBe(false);

    ui.$<HTMLButtonElement>('[data-scope="everyone"]').click();
    await vi.waitFor(() => expect(ui.texts().sort()).toEqual(["Ada's line", "Bo's line"]));
    const theirs = ui.bubble("Bo's line");
    expect(theirs.classList.contains("others")).toBe(true);
    expect(theirs.querySelector(".author")!.textContent).toBe("by Bo");
    for (const sel of ['[data-act="edit"]', '[data-act="delete"]', "[data-pick]"]) {
      expect(theirs.querySelector(sel)).toBeNull();
    }
    expect(theirs.querySelector('[data-act="speak"]')).not.toBeNull();
    expect(theirs.querySelector('[data-act="copy"]')).not.toBeNull();
    expect(ui.bubble("Ada's line").querySelector('[data-act="edit"]')).not.toBeNull();

    ui.$<HTMLButtonElement>('[data-scope="mine"]').click();
    await vi.waitFor(() => expect(ui.texts()).toEqual(["Ada's line"]));
  });

  it("playing someone else's text counts for that text", async () => {
    await seedUser("Bo", ["Bo's line"]);
    const ui = await boot();
    await ui.signUp("Ada", "ada@example.com", "secret123");
    await ui.signedInAs("Ada");
    ui.$<HTMLButtonElement>('[data-scope="everyone"]').click();
    await vi.waitFor(() => expect(ui.texts()).toEqual(["Bo's line"]));
    ui.bubble("Bo's line").querySelector<HTMLButtonElement>('[data-act="speak"]')!.click();
    expect(ui.bubble("Bo's line").querySelector(".meta")!.textContent).toBe("1 play");
    await vi.waitFor(async () => {
      const { rows } = await testPool.query("select count(*)::int n from public.plays");
      expect(rows[0].n).toBe(1);
    });
  });
});

describe("dashboard scopes", () => {
  it("registered users see Overall: the best text across everyone, with its author", async () => {
    await seedUser("Bo", ["Bo's hit"], 2);
    const ui = await boot();
    await ui.signUp("Ada", "ada@example.com", "secret123");
    await ui.signedInAs("Ada");
    ui.$<HTMLButtonElement>('[data-tab="dashboard"]').click();
    await vi.waitFor(() => expect(document.querySelector('[data-dash-scope="overall"]')).not.toBeNull());

    // Mine: Ada has no plays yet
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("0"));

    ui.$<HTMLButtonElement>('[data-dash-scope="overall"]').click();
    await vi.waitFor(() => expect(ui.$(".tile.wide .value").textContent).toBe("Bo's hit"));
    expect(ui.$(".tile.wide").textContent).toMatch(/by Bo/);
    expect(ui.$('[data-stat="plays"]').textContent).toBe("2");
  });
});

describe("Mine = your listening (dashboard)", () => {
  it("playing someone else's text today shows up today in your Mine", async () => {
    await seedUser("Bo", ["Bo's line"]);
    const ui = await boot();
    await ui.signUp("Ada", "ada@example.com", "secret123");
    await ui.signedInAs("Ada");
    await vi.waitFor(() => expect(ui.texts()).toEqual(["Bo's line"])); // Everyone is the default
    ui.bubble("Bo's line").querySelector<HTMLButtonElement>('[data-act="speak"]')!.click();
    ui.$<HTMLButtonElement>('[data-tab="dashboard"]').click();
    await vi.waitFor(() => expect(ui.$('[data-stat="plays"]').textContent).toBe("1"));
    const days = [...document.querySelectorAll<HTMLElement>('[data-card="daily"] .col-hit')];
    expect(days.at(-1)!.dataset.tip).toMatch(/1 play/);
    expect(ui.$(".tile.wide").textContent).toMatch(/Bo's line/);
    expect(ui.$(".tile.wide").textContent).toMatch(/by Bo/);
  });
});
