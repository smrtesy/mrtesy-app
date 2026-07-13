/**
 * smrtVault extension — background service worker (MV3).
 *
 * What it does: lets you autofill a login you stored in smrtVault straight into
 * the site you're on. The password is fetched from the smrtVault backend ONLY at
 * the moment you click "fill", is injected directly into the page's password
 * field, and is NEVER shown in the popup nor persisted to disk.
 *
 * How it authenticates: it reuses your existing smrtesy web session. The Supabase
 * auth cookie set by app.smrtesy.com is read via chrome.cookies, and refreshed
 * against Supabase when the access token has expired. No new backend/auth surface.
 *
 * Security model (honest): this is server-side encryption (the smrtVault backend
 * can decrypt), so it is "very secure", not "zero-knowledge". The PIN + auto-lock
 * gate the extension UI and stop casual misuse of an unlocked browser; they are a
 * usability lock, not a cryptographic guarantee (a determined attacker with your
 * unlocked machine could read the session token regardless). The real protections
 * are: the plaintext password is fetched on demand and never stored locally, and
 * it never reaches the popup — only the target site's field.
 *
 * Config below is all PUBLIC (Supabase URL + anon key). The backend URL is set by
 * the user in the options page (it is a private Railway host, not shipped here).
 */

const SUPABASE_URL = "https://exjnlghuzuvqedlltztz.supabase.co";
// Public anon key (safe to ship — it is embedded in the web app's client bundle).
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4am5sZ2h1enV2cWVkbGx0enR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMTkyMDEsImV4cCI6MjA5MTY5NTIwMX0.u2iFb_bf-OOwntz67dsM482q6STUegah-dvYTAOPEGQ";
const PROJECT_REF = "exjnlghuzuvqedlltztz";
const COOKIE_DOMAIN = "smrtesy.com";
const DEFAULT_AUTO_LOCK_MIN = 5;
const AUTOLOCK_ALARM = "sv-autolock";

// ── small helpers ────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
/**
 * Decode a base64url string (URL alphabet, no padding) to a UTF-8 string.
 * @supabase/ssr stores the auth cookie as `base64-<base64url(json)>` with
 * cookieEncoding "base64url" by default, so plain atob() (standard base64)
 * throws on the `-`/`_` chars — this handles it.
 */
function b64urlToString(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** Constant-time-ish string compare (both are fixed-length b64 hashes). */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── auth: read + refresh the smrtesy Supabase session ─────────────────────────

/** Order of a chunked supabase cookie: `sb-<ref>-auth-token` = 0, `...token.N` = N. */
function chunkIndex(name, base) {
  if (name === base) return 0;
  const m = name.slice(base.length).match(/^\.(\d+)$/);
  return m ? Number(m[1]) : 9999;
}

/** Normalize whatever supabase stored into { access_token, refresh_token, expires_at }. */
function normalizeSession(obj) {
  if (!obj) return null;
  const s = obj.currentSession || obj.session || obj;
  if (!s || !s.access_token) return null;
  let exp = s.expires_at;
  if (!exp && s.expires_in) exp = nowSec() + Number(s.expires_in);
  return { access_token: s.access_token, refresh_token: s.refresh_token || null, expires_at: exp || 0 };
}

/** Read the session from the smrtesy auth cookie(s). Handles chunked + base64- forms. */
async function readSessionFromCookies() {
  const base = `sb-${PROJECT_REF}-auth-token`;
  let all;
  try {
    all = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  } catch {
    return null;
  }
  const parts = all
    .filter((c) => c.name === base || c.name.startsWith(base + "."))
    .sort((a, b) => chunkIndex(a.name, base) - chunkIndex(b.name, base));
  if (parts.length === 0) return null;

  let raw = parts.map((p) => p.value).join("");
  try {
    // Cookie values arrive URL-encoded from chrome.cookies in some Chrome builds.
    if (/%[0-9A-Fa-f]{2}/.test(raw)) raw = decodeURIComponent(raw);
  } catch { /* keep raw */ }
  if (raw.startsWith("base64-")) {
    // @supabase/ssr uses base64URL encoding (default), not standard base64.
    try { raw = b64urlToString(raw.slice(7)); } catch { return null; }
  }
  try {
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function refreshSession(refreshToken) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    return normalizeSession(await res.json());
  } catch {
    return null;
  }
}

/** Get a valid access token: cached → fresh cookie → refresh. Null if not logged in. */
async function getAccessToken() {
  const cached = (await chrome.storage.session.get("sv_session")).sv_session;
  if (cached && cached.access_token && cached.expires_at - 60 > nowSec()) {
    return cached.access_token;
  }

  const fromCookie = await readSessionFromCookies();
  if (fromCookie && fromCookie.access_token && fromCookie.expires_at - 60 > nowSec()) {
    await chrome.storage.session.set({ sv_session: fromCookie });
    return fromCookie.access_token;
  }

  const rt = (fromCookie && fromCookie.refresh_token) || (cached && cached.refresh_token);
  if (rt) {
    const refreshed = await refreshSession(rt);
    if (refreshed && refreshed.access_token) {
      await chrome.storage.session.set({ sv_session: refreshed });
      return refreshed.access_token;
    }
  }
  return null;
}

// ── smrtVault backend API ─────────────────────────────────────────────────────

async function getBackendUrl() {
  const url = (await chrome.storage.local.get("backendUrl")).backendUrl;
  return url ? url.replace(/\/+$/, "") : null;
}

async function getOrgId(token, base) {
  const cached = (await chrome.storage.session.get("sv_org")).sv_org;
  if (cached) return cached;
  const res = await fetch(`${base}/api/orgs/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  const id = j.orgs && j.orgs[0] && j.orgs[0].id;
  if (id) await chrome.storage.session.set({ sv_org: id });
  return id || null;
}

async function apiGet(path) {
  const base = await getBackendUrl();
  if (!base) throw new Error("backend_not_configured");
  const token = await getAccessToken();
  if (!token) throw new Error("not_logged_in");
  const org = await getOrgId(token, base);
  if (!org) throw new Error("no_org");
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Org-Id": org },
  });
  if (res.status === 401) {
    await chrome.storage.session.remove("sv_session");
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `http_${res.status}`);
  }
  return res.json();
}

const listCredentials = () => apiGet("/api/vault/credentials");
const revealCredential = (id) => apiGet(`/api/vault/credentials/${encodeURIComponent(id)}/reveal`);

// ── PIN lock + auto-lock ───────────────────────────────────────────────────────

async function derivePin(pin, saltBytes, iterations = 100000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return bufToB64(bits);
}

async function hasPin() {
  return !!(await chrome.storage.local.get("sv_pin")).sv_pin;
}

async function setPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePin(pin, salt);
  await chrome.storage.local.set({ sv_pin: { salt: bufToB64(salt), hash, iter: 100000 } });
}

async function verifyPin(pin) {
  const rec = (await chrome.storage.local.get("sv_pin")).sv_pin;
  if (!rec) return false;
  const hash = await derivePin(pin, b64ToBytes(rec.salt), rec.iter || 100000);
  return safeEqual(hash, rec.hash);
}

async function autoLockMinutes() {
  const m = (await chrome.storage.local.get("autoLockMin")).autoLockMin;
  return Number(m) > 0 ? Number(m) : DEFAULT_AUTO_LOCK_MIN;
}

async function armAutoLock() {
  chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: await autoLockMinutes() });
}

async function isUnlocked() {
  return !!(await chrome.storage.session.get("sv_unlocked")).sv_unlocked;
}

async function unlock(pin) {
  if (!(await verifyPin(pin))) return false;
  await chrome.storage.session.set({ sv_unlocked: true });
  await armAutoLock();
  return true;
}

async function lock() {
  await chrome.storage.session.set({ sv_unlocked: false });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === AUTOLOCK_ALARM) lock();
});

// ── fill: injected into the active tab (runs in the page's isolated world) ──────

/** Serialized into the page by chrome.scripting.executeScript. Self-contained. */
function injectedFill(username, password) {
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };

  const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(
    (i) => !i.disabled && !i.readOnly && visible(i),
  );
  if (!pw) return { ok: false, reason: "no_password_field" };

  // Username: the last eligible text/email/tel input that appears BEFORE the
  // password field in DOM order, within the same form when there is one.
  const scope = pw.form || document;
  const userTypes = ["text", "email", "tel", "username", ""];
  const all = Array.from(scope.querySelectorAll("input"));
  const pwIdx = all.indexOf(pw);
  let user = null;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (pwIdx !== -1 && i >= pwIdx) break;
    if (el.disabled || el.readOnly || !visible(el)) continue;
    if (userTypes.includes((el.type || "").toLowerCase())) user = el;
  }

  if (username && user) setNativeValue(user, username);
  if (password) setNativeValue(pw, password);
  (user || pw).focus();
  return { ok: true, filledUser: !!(username && user), filledPassword: !!password };
}

async function fillActiveTab(username, password) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, reason: "no_tab" };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedFill,
      args: [username || "", password || ""],
    });
    return (res && res.result) || { ok: false, reason: "no_result" };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ── message router (popup + options) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "STATE": {
          const base = await getBackendUrl();
          return sendResponse({
            backendConfigured: !!base,
            loggedIn: base ? (await getAccessToken()) !== null : false,
            pinSet: await hasPin(),
            unlocked: await isUnlocked(),
            autoLockMin: await autoLockMinutes(),
          });
        }
        case "SET_PIN": {
          const pin = String(msg.pin || "");
          if (pin.length < 4) return sendResponse({ ok: false, error: "pin_too_short" });
          await setPin(pin);
          await chrome.storage.session.set({ sv_unlocked: true });
          await armAutoLock();
          return sendResponse({ ok: true });
        }
        case "UNLOCK": {
          const ok = await unlock(String(msg.pin || ""));
          return sendResponse({ ok });
        }
        case "LOCK":
          await lock();
          return sendResponse({ ok: true });
        case "LIST": {
          if (!(await isUnlocked())) return sendResponse({ error: "locked" });
          await armAutoLock();
          const { credentials } = await listCredentials();
          return sendResponse({ credentials: credentials || [] });
        }
        case "FILL": {
          if (!(await isUnlocked())) return sendResponse({ error: "locked" });
          await armAutoLock();
          const { username, password } = await revealCredential(String(msg.id));
          const result = await fillActiveTab(username, password);
          // Never return the password to the popup — only the fill outcome.
          return sendResponse(result.ok ? { ok: true, ...result } : { ok: false, error: result.reason });
        }
        default:
          return sendResponse({ error: "unknown_message" });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});
