# Comparoz — Browser Extension (skeleton)

The extension is a **thin authenticated-fetch engine**. It fetches store pages
using the user's own logged-in session and hands the raw HTML to comparoz.com,
which sends it to the server's existing price-tracker parsers. This is how we
get the real prices the user pays (Amazon Business / member prices) without any
server-side scraping or stored credentials.

## Where the DESIGN / UI lives

**Not here.** The product UI — comparison table, alternatives zone, kosher
toggle, AI-cost meter — is the **Next.js web app** (`src/app/[locale]/(app)/(platform)/admin/price-tracker/`).
The extension has only a tiny **popup** (connection status + a link to the
site). Keep building the experience in the web app; the extension stays a
background engine.

## What's implemented

- `manifest.json` — MV3, `cookies`/`alarms`/`storage`, host permissions for
  amazon.com + walmart.com, `externally_connectable` for comparoz.com, and a
  presence content script.
- `background.js` — message router for the site:
  - `comparoz.status` — per-store connection (session-cookie check).
  - `comparoz.compare` — fetches each product page twice (anonymous = regular
    price, with-session = business/member price) and returns raw HTML.
  - `comparoz.connect` — opens the store's login tab.
  - throttling (max 2 concurrent + jitter) and a daily refresh alarm.
- `presence.js` — tells the site the extension is installed (+ its id).
- `popup.html` / `popup.js` — status + connect.

## What's still TODO (next steps)

1. **Server parse endpoint** — add `POST /api/admin/price-tracker/parse`
   that accepts `{store, regularHtml, businessHtml}` and returns a
   `PriceResult` (reuse the existing parsers; extract `regular` + `business`).
   The site calls it with what `comparoz.compare` returns.
2. **Orders/returns** — `comparoz.orders` should fetch your-orders/returns with
   the session and **parse client-side** (PII), uploading only minimal JSON.
3. **Daily refresh** — pull the user's product list from the server, refresh,
   and upload, so the weekly email has fresh personal prices.
4. **Web-app bridge** — on comparoz.com, read `data-comparoz-ext` (or the
   `postMessage`) to get the extension id, then
   `chrome.runtime.sendMessage(extId, {...})`.

## Load it for testing (you do this — it can't be tested server-side)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Copy the assigned **Extension ID** (the site needs it; or read it via the
   presence script).
4. Make sure you're logged into Amazon/Walmart in that browser, click the
   Comparoz icon → you should see "מחובר".

> Replace `https://comparoz.com` with your real domain and add a `localhost`
> entry while developing (already included).
