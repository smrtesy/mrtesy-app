# smrtVault browser extension

Autofill your [smrtVault](../src/components/smrtvault) logins straight into any
website. A password is fetched from the smrtVault backend **only at the moment
you fill it**, typed directly into the site's password field, and is **never
shown in the extension nor stored on your device**.

This is the phase-2 companion to the in-app vault: the web app stores and
manages logins (and never displays passwords); this extension is what actually
fills them.

## How it works

- **Auth** — it reuses your existing smrtesy session. The Supabase auth cookie
  set by `app.smrtesy.com` is read via `chrome.cookies` and refreshed against
  Supabase when the access token expires. No new backend or login is needed;
  if you're signed in to smrtesy in the same browser, the extension is signed in.
- **Fill** — clicking a login in the popup calls `GET /api/vault/credentials/:id/reveal`
  on your backend, then injects the username/password into the active tab via
  `chrome.scripting.executeScript` (on-demand, `activeTab` only — there is **no**
  content script sitting on every page). The password goes background → page
  field; it never touches the popup UI.
- **Lock** — a PIN gates the popup, and the vault auto-locks after N minutes of
  inactivity (configurable). After locking, filling requires the PIN again.
- **Capture (opt-in, off by default)** — instead of importing everything from
  Chrome, you can let the extension notice a login as you sign in and offer to
  save it, so only the accounts you actually use land in the vault. Enable it in
  options (it asks permission to watch form submissions on sites). When you sign
  in to a *new* login, a notification asks whether to save it; the password is
  sent to the vault **only if you click Save**, is held in memory (never disk)
  until then, and existing logins are left alone. Uses `POST /api/vault/credentials`.

## Security model (honest)

This uses **server-side encryption** — the smrtVault backend can decrypt your
passwords to return them for autofill. That makes it *very secure* (encrypted at
rest in Supabase Vault, private per user, audited on every reveal) but **not
zero-knowledge**. The PIN + auto-lock are a **usability lock** that stops casual
misuse of an unlocked browser; they are not a cryptographic guarantee — someone
with your unlocked machine and devtools could read the session token regardless.
The meaningful protections are: the plaintext password is fetched on demand,
never persisted locally, and never surfaced in the extension UI — only the
target site's field receives it.

## Install (unpacked, for testing)

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → select this `smrtvault-extension/` folder.
3. Click the smrtVault icon → **Settings**:
   - **Backend URL** — paste the value of `NEXT_PUBLIC_BACKEND_URL` (Vercel →
     Project → Settings → Environment Variables), e.g.
     `https://your-app.up.railway.app`. Saving prompts for permission to reach
     that host — approve it.
   - Optionally adjust the **auto-lock** minutes.
4. Make sure you're signed in to `https://app.smrtesy.com` in the same browser.
5. Open the popup → **create a PIN** → you'll see your logins. On a site with a
   login form, click a credential to autofill.

## Configuration baked in

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `background.js` are the **public**
  Supabase project URL and anon key (the same ones shipped in the web app's
  client bundle — safe to include).
- The **backend URL is not shipped** (it's a private host) — you set it in
  options on first run.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (permissions: cookies, storage, alarms, scripting, activeTab) |
| `background.js` | Service worker: auth (cookie read + refresh), backend API, PIN/auto-lock, fill injection, login capture + save, message router |
| `popup.html/.css/.js` | Popup UI: setup states, PIN, searchable login list, fill |
| `capture.js` | Content script (registered only while capture is on): detects a submitted login and reports it for a save prompt |
| `options.html/.js` | Backend URL + host permission, auto-lock, login-capture toggle, PIN reset |
| `icons/` | Extension icons |

## Not yet included (possible follow-ups)

- Biometric unlock (WebAuthn platform authenticator) as an alternative to the PIN.
- An inline in-page fill button on detected login forms.
- Packaging/signing for the Chrome Web Store.

## Claude tracking (workclock)

The extension doubles as the smrtesy workclock's eyes on Claude Code
(docs/workclock-plan.md §11). `claude-capture.js` runs on `claude.ai/code/*` and
reports the current **session link + best-effort status** (running /
waiting-on-you / done) to smrtesy via the background worker
(`POST /api/tasks/claude-actions`), so the workclock bar tracks your Claude
sessions — and flags when Claude is **waiting for you** — without babysitting
the tab.

- **Status is heuristic, not an API.** Most reliable signal: claude.ai's own
  notification (a page-world shim wraps `window.Notification`); title changes
  are a backup; the DOM "is it generating" check is the most fragile and
  **needs tuning against the live UI** (`detectDomStatus()`).
- **Authoritative outcome = GitHub** (the resulting PR), tracked separately.
- Adds `https://claude.ai/*` host permission + the content script; never touches
  the vault.

## Note

This extension was written against the smrtVault API but has **not been
exercised end-to-end in a real Chrome profile** in this environment. Load it
unpacked and test both flows — login detection → fill, AND the `claude.ai/code`
status reporting → the workclock bar's 🤖 tracker — before relying on it.
