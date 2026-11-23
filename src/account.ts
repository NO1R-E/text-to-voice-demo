/**
 * Account UI: Sign up / Sign in / Sign out, and the Mine | Everyone switch.
 *
 * Every visitor starts as an anonymous Supabase user. "Sign up" upgrades that same
 * user (so their texts stay); "Sign in" switches to an existing account.
 */
import { store, type Scope } from "./store";
import { esc } from "./util";

type Mode = "signup" | "signin";

export function setupAccount(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const area = $("account");
  const panel = $("auth-panel");
  const form = $<HTMLFormElement>("auth-form");
  const nameRow = $("auth-name-row");
  const nameIn = $<HTMLInputElement>("auth-name");
  const emailIn = $<HTMLInputElement>("auth-email");
  const passIn = $<HTMLInputElement>("auth-password");
  const errorEl = $("auth-error");
  const warning = $("auth-warning");
  const submit = $<HTMLButtonElement>("auth-submit");
  const switchBtn = $<HTMLButtonElement>("auth-switch");
  const scopeEl = $("scope");
  let mode: Mode = "signup";

  // ---------- header area ----------
  function renderArea(): void {
    const a = store.account;
    if (a && !a.anonymous) {
      area.innerHTML = `<span class="account-name" title="${esc(a.email ?? "")}">${esc(a.displayName ?? "Me")}</span>
        <button type="button" id="sign-out" class="ghost sm">Sign out</button>`;
    } else {
      area.innerHTML = `<span class="muted guest" title="Your texts are private to this browser">Guest</span>
        <button type="button" id="open-signin" class="ghost sm">Sign in</button>
        <button type="button" id="open-signup" class="primary sm">Sign up</button>`;
    }
  }

  function renderScope(): void {
    scopeEl.hidden = !store.registered;
    scopeEl.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.scope === store.scope)),
    );
  }

  // ---------- auth panel ----------
  function open(m: Mode): void {
    mode = m;
    const signup = m === "signup";
    $("auth-title").textContent = signup ? "Sign up" : "Sign in";
    $("auth-hint").textContent = signup
      ? "Keep your texts on any device and share them with other registered users. Your current texts come with you."
      : "Sign in to your account.";
    nameRow.hidden = !signup;
    passIn.autocomplete = signup ? "new-password" : "current-password";
    submit.textContent = signup ? "Sign up" : "Sign in";
    switchBtn.textContent = signup ? "Already have an account? Sign in" : "New here? Sign up";
    errorEl.textContent = "";

    // Signing in leaves this guest space behind (signing up keeps it).
    const mine = store.texts.filter((t) => t.isMine).length;
    warning.hidden = signup || !store.account?.anonymous || mine === 0;
    warning.textContent = `Your ${mine} text${mine === 1 ? "" : "s"} in this guest space won't come with you. To keep ${
      mine === 1 ? "it" : "them"
    }, use Sign up instead.`;

    panel.hidden = false;
    (signup ? nameIn : emailIn).focus();
  }

  function close(): void {
    panel.hidden = true;
    form.reset();
    errorEl.textContent = "";
  }

  function validate(): string | null {
    const email = emailIn.value.trim();
    if (mode === "signup") {
      const name = nameIn.value.trim();
      if (!name) return "Please enter a display name.";
      if (name.length > 40) return "Display name must be 40 characters or fewer.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Please enter a valid email address.";
    if (passIn.value.length < 6) return "Password must be at least 6 characters.";
    return null;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      errorEl.textContent = problem;
      return;
    }
    errorEl.textContent = "";
    submit.disabled = true;
    try {
      if (mode === "signup") {
        const result = await store.signUp(nameIn.value.trim(), emailIn.value.trim(), passIn.value);
        if (result === "confirm") {
          errorEl.textContent = "Check your email and click the confirmation link, then sign in here.";
          return;
        }
      } else {
        await store.signIn(emailIn.value.trim(), passIn.value);
      }
      close();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      submit.disabled = false;
    }
  });

  switchBtn.addEventListener("click", () => open(mode === "signup" ? "signin" : "signup"));
  $("auth-cancel").addEventListener("click", close);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  area.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    if (btn.id === "open-signup") open("signup");
    else if (btn.id === "open-signin") open("signin");
    else if (btn.id === "sign-out") {
      btn.disabled = true;
      await store.signOut();
    }
  });

  scopeEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-scope]");
    if (btn) void store.setScope(btn.dataset.scope as Scope);
  });

  store.subscribe(() => {
    renderArea();
    renderScope();
  });
  renderArea();
  renderScope();
}
