/**
 * Comparoz extension — background service worker (MV3).
 *
 * The extension is a thin AUTHENTICATED FETCH engine. It does not parse or
 * decide; it fetches store pages using the user's own logged-in session and
 * hands the raw HTML back to comparoz.com, which forwards it to the server's
 * existing parsers. This is what gets the real prices the user pays
 * (Amazon Business, member prices) without any server-side scraping.
 *
 * Message API (comparoz.com → extension via chrome.runtime.sendMessage(EXT_ID, msg)):
 *   { type: "comparoz.status" }                         → connection state per store
 *   { type: "comparoz.compare", items: [{store,url}] }  → { results: [{store,url,regularHtml,businessHtml,...}] }
 *   { type: "comparoz.orders", store }                  → raw orders/returns HTML (TODO: parse client-side for PII)
 *   { type: "comparoz.connect", store }                 → opens the store login tab
 *
 * NOTE: prices/orders are PARSED on the server (price-tracker parsers), except
 * order/return pages which carry PII and should be parsed here before upload.
 */

const STORES = {
  amazon:        { host: "www.amazon.com",   login: "https://www.amazon.com/ap/signin", cookie: "at-main",  account: "https://www.amazon.com/gp/css/homepage.html" },
  walmart:       { host: "www.walmart.com",  login: "https://www.walmart.com/account/login", cookie: "CID", account: "https://www.walmart.com/account" },
};

const UA = navigator.userAgent;
const TIMEOUT_MS = 25000;
// simple throttle: at most N concurrent fetches, with jitter, to stay polite.
let inflight = 0;
const MAX_INFLIGHT = 2;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
async function pump() {
  if (inflight >= MAX_INFLIGHT || queue.length === 0) return;
  const { fn, resolve, reject } = queue.shift();
  inflight++;
  try {
    await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 400))); // jitter
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    inflight--;
    pump();
  }
}

async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(opts && opts.headers) } });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } finally {
    clearTimeout(t);
  }
}

/** Is there a live session cookie for this store? (fast signal) */
async function isConnected(storeKey) {
  const s = STORES[storeKey];
  if (!s) return false;
  try {
    const cookie = await chrome.cookies.get({ url: `https://${s.host}/`, name: s.cookie });
    return !!cookie;
  } catch {
    return false;
  }
}

async function getStatus() {
  const stores = {};
  for (const key of Object.keys(STORES)) {
    stores[key] = { connected: await isConnected(key) };
  }
  // amazon business is the same session; the server detects "business" from the page.
  return { installed: true, version: chrome.runtime.getManifest().version, stores };
}

/**
 * Fetch a product page twice: anonymous (regular price) and with the user's
 * session (business/member price). The server parses both and computes
 * regular-vs-business + per-oz. Returns raw HTML — no parsing here.
 */
async function comparePrice(item) {
  const { store, url } = item;
  try {
    const [regular, business] = await Promise.all([
      schedule(() => timedFetch(url, { credentials: "omit" })),
      schedule(() => timedFetch(url, { credentials: "include" })),
    ]);
    return {
      store, url, ok: true,
      regularHtml: regular.html, regularStatus: regular.status,
      businessHtml: business.html, businessStatus: business.status,
    };
  } catch (e) {
    return { store, url, ok: false, error: String((e && e.message) || e) };
  }
}

// message router (from comparoz.com)
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "comparoz.status":
          return sendResponse(await getStatus());
        case "comparoz.compare": {
          const items = Array.isArray(msg.items) ? msg.items.slice(0, 20) : [];
          const results = await Promise.all(items.map(comparePrice));
          return sendResponse({ results });
        }
        case "comparoz.connect": {
          const s = STORES[msg.store];
          if (!s) return sendResponse({ connected: false, error: "unknown store" });
          await chrome.tabs.create({ url: s.login });
          return sendResponse({ connected: false, opened: true }); // site re-polls status
        }
        case "comparoz.orders":
          // TODO: fetch your-orders/returns with session, PARSE HERE (PII), return minimal JSON.
          return sendResponse({ orders: [], todo: "parse orders client-side before upload" });
        default:
          return sendResponse({ error: "unknown message type" });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});

// internal messages from the popup (same extension)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "comparoz.status") return sendResponse(await getStatus());
      if (msg && msg.type === "comparoz.connect") {
        const s = STORES[msg.store];
        if (s) await chrome.tabs.create({ url: s.login });
        return sendResponse({ opened: !!s });
      }
      sendResponse({ error: "unknown message type" });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// daily background refresh hook (wired to a server "pending refresh" list later)
chrome.alarms.create("comparoz.dailyRefresh", { periodInMinutes: 60 * 24 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "comparoz.dailyRefresh") {
    // TODO: pull the user's product list from the server, refresh prices, upload.
  }
});
