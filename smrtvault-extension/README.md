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
| `background.js` | Service worker: auth (cookie read + refresh), backend API, PIN/auto-lock, fill injection, message router |
| `popup.html/.css/.js` | Popup UI: setup states, PIN, searchable login list, fill |
| `options.html/.js` | Backend URL + host permission, auto-lock, PIN reset |
| `icons/` | Extension icons |

## Not yet included (possible follow-ups)

- Biometric unlock (WebAuthn platform authenticator) as an alternative to the PIN.
- An inline in-page fill button on detected login forms.
- Packaging/signing for the Chrome Web Store.

## Note

This extension was written against the smrtVault API but has **not been
exercised end-to-end in a real Chrome profile** in this environment. Load it
unpacked and test the flow (login detection → fill) before relying on it.
