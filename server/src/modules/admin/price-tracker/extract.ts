/**
 * Price-tracker extraction engine.
 *
 * Given a product URL from one of the supported stores, pull the live
 * price, title, brand, image and package size — then normalize the size
 * to ounces so prices can be compared per-oz (the whole point of the
 * tool: a real apples-to-apples comparison, not sticker price).
 *
 * Two fetch strategies, tried in order:
 *   1. Raw HTTPS fetch with a browser User-Agent. Fast, cheap, and enough
 *      for Amazon (which serves full price markup to a plain GET).
 *   2. Headless Chromium (Playwright) fallback when the raw fetch is
 *      blocked or empty. Walmart and Costco sit behind Akamai / bot
 *      managers that reject raw GETs; a real browser sometimes gets
 *      through. Playwright is only available where Chromium is installed
 *      (the Railway backend, not every sandbox) — if it isn't, we report
 *      the block honestly rather than crashing.
 *
 * Parsing is deterministic (JSON-LD + store-specific selectors + regex).
 * Claude is used only for the fuzzy bit: judging kosher status from the
 * product text.
 */

import { simpleCall, parseJsonResponse } from "../../../anthropic";

export type Store =
  | "amazon"
  | "amazon_fresh"
  | "walmart"
  | "costco"
  | "costco_sameday";

export const STORE_LABELS: Record<Store, string> = {
  amazon: "Amazon",
  amazon_fresh: "Amazon Fresh",
  walmart: "Walmart",
  costco: "Costco",
  costco_sameday: "Costco Same-Day",
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FetchResult {
  html: string;
  status: number;
  blocked: boolean;
  viaBrowser: boolean;
}

export interface ParsedSize {
  value: number; // total amount expressed in `unit`
  unit: "oz" | "count";
  label: string; // the human string we parsed it from
}

export interface ParsedProduct {
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  price: number | null;
  currency: string;
  inStock: boolean | null;
  size: ParsedSize | null;
}

// ── store detection ──────────────────────────────────────────────────────────

export function detectStore(rawUrl: string): Store | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes("sameday.costco.com") || host.includes("instacart"))
    return "costco_sameday";
  if (host.includes("costco.com")) return "costco";
  if (host.includes("walmart.com")) return "walmart";
  // amazon.com covers both the regular store and Fresh; the link alone can't
  // distinguish them, so we default to "amazon" and let the operator retag.
  if (host.includes("amazon.")) return "amazon";
  return null;
}

// ── fetching ──────────────────────────────────────────────────────────────────

/** Heuristic: did we get a bot-wall / empty body instead of a real page? */
function looksBlocked(html: string): boolean {
  if (html.length < 1500) return true;
  return /access denied|robot or human|are you a human|enter the characters|px-captcha|verify you are|unusual traffic|to discuss automated access|request was blocked/i.test(
    html.slice(0, 6000),
  );
}

async function rawFetch(url: string): Promise<FetchResult> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const html = await resp.text();
  return {
    html,
    status: resp.status,
    blocked: !resp.ok || looksBlocked(html),
    viaBrowser: false,
  };
}

async function browserFetch(url: string): Promise<FetchResult> {
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    });
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: "en-US",
      viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
    // Give client-rendered price widgets a moment to populate.
    await page.waitForTimeout(3_000);
    const html = await page.content();
    const status = resp ? resp.status() : 0;
    await browser.close();
    browser = null;
    return { html, status, blocked: looksBlocked(html), viaBrowser: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Fetch through a third-party scraping provider (residential proxies + a
 * real rendering engine). This is the only reliable way past Walmart's and
 * Costco's Akamai / PerimeterX edge protection — a headless browser from a
 * datacenter IP gets fingerprinted and blocked. Provider-agnostic: set
 *   SCRAPER_PROVIDER = "scraperapi" | "scrapingbee"
 *   SCRAPER_API_KEY  = <key>
 *   SCRAPER_ULTRA    = "true"   (optional — residential/ultra tier; Walmart
 *                                often needs it)
 * Returns null when no provider is configured so callers can fall back.
 */
async function providerFetch(url: string): Promise<FetchResult | null> {
  const provider = (process.env.SCRAPER_PROVIDER ?? "").toLowerCase();
  const key = process.env.SCRAPER_API_KEY ?? "";

  // Premium providers (paid, residential proxies) take precedence when keyed.
  if (key && (provider === "scraperapi" || provider === "scrapingbee")) {
    const ultra = (process.env.SCRAPER_ULTRA ?? "").toLowerCase() === "true";
    let endpoint: string;
    if (provider === "scrapingbee") {
      const p = new URLSearchParams({ api_key: key, url, render_js: "true", country_code: "us" });
      if (ultra) p.set("premium_proxy", "true");
      endpoint = `https://app.scrapingbee.com/api/v1/?${p.toString()}`;
    } else {
      const p = new URLSearchParams({ api_key: key, url, render: "true", country_code: "us" });
      if (ultra) p.set("ultra_premium", "true");
      endpoint = `https://api.scraperapi.com/?${p.toString()}`;
    }
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(70_000) });
    const html = await resp.text();
    return { html, status: resp.status, blocked: !resp.ok || looksBlocked(html), viaBrowser: true };
  }

  // Free default: Jina Reader (r.jina.ai) — renders the page through its own
  // browser + proxy pool and returns full HTML, which sails past Walmart's and
  // Costco's Akamai edge. An optional JINA_API_KEY raises the rate limit.
  return jinaFetch(url);
}

/** Jina Reader fetch in full-HTML mode. Free; no key required. */
async function jinaFetch(url: string): Promise<FetchResult> {
  const headers: Record<string, string> = { "X-Return-Format": "html" };
  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(70_000),
  });
  const html = await resp.text();
  return { html, status: resp.status, blocked: !resp.ok || looksBlocked(html), viaBrowser: true };
}

/**
 * Fetch a page, escalating cheapest-first:
 *   1. raw GET (free; enough for Amazon)
 *   2. scraping provider, if configured (the only thing that beats Akamai)
 *   3. local headless browser (last resort; works for soft blocks)
 * Never throws on a browser-unavailable env — the best blocked result is
 * returned so the caller can report it honestly.
 */
export async function fetchPage(url: string): Promise<FetchResult> {
  const attempts: FetchResult[] = [];

  try {
    const raw = await rawFetch(url);
    if (!raw.blocked) return raw;
    attempts.push(raw);
  } catch {
    /* continue escalating */
  }

  try {
    const viaProvider = await providerFetch(url);
    if (viaProvider) {
      if (!viaProvider.blocked) return viaProvider;
      attempts.push(viaProvider);
    }
  } catch {
    /* provider error — fall through to local browser */
  }

  try {
    const viaBrowser = await browserFetch(url);
    if (!viaBrowser.blocked) return viaBrowser;
    attempts.push(viaBrowser);
  } catch {
    /* browser unavailable */
  }

  // Everything was blocked / errored — return whichever attempt carried the
  // most markup (best chance the parser still finds a price), or an empty
  // blocked result if we got nothing at all.
  if (!attempts.length) return { html: "", status: 0, blocked: true, viaBrowser: false };
  return attempts.reduce((a, b) => (b.html.length > a.html.length ? b : a));
}

// ── size normalization ─────────────────────────────────────────────────────────

// Conversion of a single unit token to ounces. Fluid and weight ounces share
// the "oz" axis on purpose — the operator asked for one per-OZ number, and a
// product is never sold by both at once.
const TO_OZ: Record<string, number> = {
  oz: 1,
  ounce: 1,
  ounces: 1,
  "fl oz": 1,
  floz: 1,
  "fluid ounce": 1,
  "fluid ounces": 1,
  lb: 16,
  lbs: 16,
  pound: 16,
  pounds: 16,
  g: 1 / 28.3495,
  gram: 1 / 28.3495,
  grams: 1 / 28.3495,
  kg: 35.274,
  ml: 0.033814,
  l: 33.814,
  liter: 33.814,
  liters: 33.814,
  litre: 33.814,
};

const COUNT_WORDS =
  /(\d+(?:\.\d+)?)\s*-?\s*(count|ct|pack|pk|pieces|piece|ea|each|capsules|tablets|bags|bars|pods|rolls|sheets|wipes)\b/i;

function unitToOz(unitRaw: string): number | null {
  const u = unitRaw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (u in TO_OZ) return TO_OZ[u];
  // collapse "fl oz" written as "floz" / "fl. oz."
  const collapsed = u.replace(/\s/g, "");
  if (collapsed in TO_OZ) return TO_OZ[collapsed];
  return null;
}

const UNIT_TOKEN = "(fl\\s*oz|fluid\\s*ounces?|ounces?|oz|lbs?|pounds?|kg|grams?|g|ml|liters?|litres?|l)";

/**
 * Parse a package size out of free text (a product title / name).
 * Handles multipacks ("4 x 16 fl oz", "2-pack 12 oz") and single sizes.
 * Returns ounces where the unit is weight/volume, otherwise a count.
 */
export function parseSize(text: string | null | undefined): ParsedSize | null {
  if (!text) return null;
  const t = text.replace(/ /g, " ");

  // Multipack with explicit unit: "4 x 16 fl oz", "4x16oz"
  const multi = new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT_TOKEN}`, "i").exec(t);
  if (multi) {
    const count = parseFloat(multi[1]);
    const each = parseFloat(multi[2]);
    const oz = unitToOz(multi[3]);
    if (oz && count > 0 && each > 0) {
      return { value: +(count * each * oz).toFixed(3), unit: "oz", label: multi[0].trim() };
    }
  }

  // A pack count combined with a single size elsewhere in the string.
  // Two phrasings: number-first ("12 Pack", "4-pk") and number-last
  // ("Pack of 4", "Case of 6") — the latter is what Walmart uses and was
  // previously missed, producing a wrong per-oz.
  const packBefore = /(\d+)\s*-?\s*(?:pack|pk|count|ct)\b/i.exec(t);
  const packAfter = /\b(?:pack|pk|case|set|box|count)\s*of\s*(\d+)/i.exec(t);
  const packMatch = packBefore ?? packAfter;
  const single = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_TOKEN}\\b`, "i").exec(t);
  if (single) {
    const each = parseFloat(single[1]);
    const oz = unitToOz(single[2]);
    if (oz && each > 0) {
      const packs = packMatch ? parseFloat(packMatch[1]) : 1;
      const total = each * oz * (packs > 0 ? packs : 1);
      const label = packMatch ? `${packMatch[1]}×${single[0].trim()}` : single[0].trim();
      return { value: +total.toFixed(3), unit: "oz", label };
    }
  }

  // Count-only products (no weight/volume): "12 count", "30 capsules"
  const count = COUNT_WORDS.exec(t);
  if (count) {
    const n = parseFloat(count[1]);
    if (n > 0) return { value: n, unit: "count", label: count[0].trim() };
  }

  return null;
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/gi, "'")
    .trim();
}

// Strip a trailing store-name suffix so the card shows the PRODUCT, not the
// store: "… - Walmart.com", ": Amazon.com", "… | Costco", and Amazon's
// "Amazon.com: <title> : <category>" wrapper.
function stripStoreSuffix(t: string): string {
  let s = t;
  s = s.replace(/^\s*amazon\.com\s*:\s*/i, "");                 // Amazon prefix
  s = s.replace(/\s*[-|:]\s*(walmart\.com|amazon\.com|costco\.com|costco|instacart)\b.*$/i, "");
  s = s.replace(/\s*:\s*(grocery|health\s*&\s*household|grocery\s*&\s*gourmet[^:]*)\s*$/i, ""); // Amazon category tail
  return s.trim();
}

// A title is "bad" when it is plainly not a product name — an internal
// placeholder, a bare date/time, or too short. The guard is deliberately
// conservative (only obvious junk) and always has a fallback, so a real title
// is never dropped.
function looksLikeBadTitle(t: string | null | undefined): boolean {
  if (!t) return true;
  const s = t.trim();
  if (s.length < 5) return true;
  if (!/[a-z֐-׿]{3,}/i.test(s)) return true;                 // no real word
  if (/placeholder|\bgrid\b|undefined|productingredients|^product\s*title$/i.test(s)) return true;
  if (/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(s)) return true;             // a clock time
  if (/\b(sun|mon|tue|wed|thu|fri|sat)\b[\s\S]*\b20\d{2}\b/i.test(s)) return true; // a date
  return false;
}

/** Pick the first clean, store-suffix-stripped title from ordered candidates. */
function pickTitle(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const cleaned = stripStoreSuffix(decodeEntities(c));
    if (!looksLikeBadTitle(cleaned)) return cleaned;
  }
  // nothing clean — return the least-bad non-empty cleaned candidate (still
  // better than null), so the caller can flag "name uncertain".
  for (const c of candidates) {
    if (c) {
      const cleaned = stripStoreSuffix(decodeEntities(c));
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const m = re.exec(html);
  if (m) return decodeEntities(m[1]);
  // attribute order can be reversed (content first)
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i",
  );
  const m2 = re2.exec(html);
  return m2 ? decodeEntities(m2[1]) : null;
}

interface JsonLdProduct {
  name?: string;
  brand?: string;
  image?: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
}

/** Pull the first schema.org Product/Offer out of any JSON-LD blocks. */
function parseJsonLd(html: string): JsonLdProduct | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(data) ? data : [data];
    // @graph wrapper
    const flat: unknown[] = [];
    for (const n of nodes) {
      if (n && typeof n === "object" && "@graph" in (n as object)) {
        const g = (n as { "@graph": unknown })["@graph"];
        if (Array.isArray(g)) flat.push(...g);
      } else {
        flat.push(n);
      }
    }
    for (const node of flat) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const type = o["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) continue;

      const out: JsonLdProduct = {};
      if (typeof o.name === "string") out.name = decodeEntities(o.name);
      const brand = o.brand;
      if (typeof brand === "string") out.brand = decodeEntities(brand);
      else if (brand && typeof brand === "object" && typeof (brand as Record<string, unknown>).name === "string")
        out.brand = decodeEntities((brand as Record<string, string>).name);
      const image = o.image;
      if (typeof image === "string") out.image = image;
      else if (Array.isArray(image) && typeof image[0] === "string") out.image = image[0] as string;

      let offer = o.offers as unknown;
      if (Array.isArray(offer)) offer = offer[0];
      if (offer && typeof offer === "object") {
        const off = offer as Record<string, unknown>;
        const p = off.price ?? off.lowPrice;
        if (p != null && !isNaN(Number(p))) out.price = Number(p);
        if (typeof off.priceCurrency === "string") out.currency = off.priceCurrency;
        const avail = off.availability;
        if (typeof avail === "string") out.inStock = /InStock/i.test(avail);
      }
      if (out.name || out.price != null) return out;
    }
  }
  return null;
}

// ── store-specific parsers ─────────────────────────────────────────────────────

function parseAmazon(html: string): ParsedProduct {
  const productTitleRaw = /<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
  const docTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  // #productTitle is Amazon's canonical, most complete title → preferred.
  const title = pickTitle(
    productTitleRaw ? productTitleRaw.replace(/<[^>]+>/g, " ") : null,
    metaContent(html, "og:title"),
    docTitle,
  );

  // Buybox price — anchored, in priority order, so we never grab a unit-price
  // ("$0.14 / Count"), a coupon, or a Subscribe&Save delta by accident:
  //   1. the .priceToPay span (the actual buy-box price)
  //   2. the corePrice feature block's a-offscreen
  //   3. Amazon's embedded "priceAmount" JSON
  //   4. apex/whole+fraction pair
  //   5. last resort: first a-offscreen on the page
  let price: number | null = null;
  const patterns: RegExp[] = [
    /class=["'][^"']*priceToPay[^"']*["'][\s\S]{0,200}?<span class=["']a-offscreen["']>\$([0-9,]+\.[0-9]{2})/i,
    /id=["']corePrice[^"']*["'][\s\S]{0,400}?<span class=["']a-offscreen["']>\$([0-9,]+\.[0-9]{2})/i,
    /"priceAmount"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /id=["']priceblock_(?:our|deal|sale)price["'][^>]*>\s*\$?([0-9,]+\.[0-9]{2})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) { price = parseFloat(m[1].replace(/,/g, "")); break; }
  }
  if (price == null) {
    // apex whole+fraction, scoped to the buy-box feature when possible
    const apex = /id=["']apex_desktop["'][\s\S]{0,600}?a-price-whole["']>([0-9,]+)[\s\S]{0,40}?a-price-fraction["']>([0-9]{2})/i.exec(html);
    const whole = apex ?? /<span class=["']a-price-whole["']>([0-9,]+)[\s\S]{0,40}?a-price-fraction["']>([0-9]{2})/i.exec(html);
    if (whole) price = parseFloat(`${whole[1].replace(/,/g, "")}.${whole[2]}`);
  }
  if (price == null) {
    const off = /<span class=["']a-offscreen["']>\$([0-9,]+\.[0-9]{2})/i.exec(html);
    if (off) price = parseFloat(off[1].replace(/,/g, ""));
  }

  const brand =
    (/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1]
      ? decodeEntities(/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)![1].replace(/<[^>]+>/g, " "))
          .replace(/^(visit the|brand:)\s*/i, "")
          .replace(/\s*store$/i, "")
      : null);

  // data-a-dynamic-image holds a JSON map of {url: [w,h]} — grab the first URL.
  const dynImg = /data-a-dynamic-image=["']\{&quot;(https:[^&]+?)&quot;/i.exec(html)?.[1]
    ?? /data-a-dynamic-image=["']\{"(https:[^"]+?)"/i.exec(html)?.[1];
  const imageUrl =
    /id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i.exec(html)?.[1] ||
    /id=["']landingImage["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ||
    dynImg ||
    metaContent(html, "og:image") ||
    /<img[^>]+id=["']landingImage["'][^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1];

  const inStock = /id=["']availability["'][\s\S]{0,200}?(in stock)/i.test(html)
    ? true
    : /currently unavailable|out of stock/i.test(html)
    ? false
    : null;

  return {
    title: title ?? null,
    brand: brand ?? null,
    imageUrl: imageUrl ?? null,
    price,
    currency: "USD",
    inStock,
    size: parseSize(title),
  };
}

/** Walmart renders product data into a __NEXT_DATA__ JSON island. */
function parseWalmart(html: string): ParsedProduct {
  const ld = parseJsonLd(html);
  let price = ld?.price ?? null;
  let title = ld?.name ?? null;
  let brand = ld?.brand ?? null;
  let imageUrl = ld?.image ?? null;
  let inStock = ld?.inStock ?? null;

  const next = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (next) {
    try {
      const json = JSON.parse(next[1]);
      const str = JSON.stringify(json);
      if (price == null) {
        const p = /"currentPrice"\s*:\s*\{[^}]*?"price"\s*:\s*([0-9.]+)/.exec(str)
          ?? /"price"\s*:\s*([0-9.]+)\s*,\s*"priceString"/.exec(str);
        if (p) price = parseFloat(p[1]);
      }
      // NOTE: do NOT pull the title from a bare "name" field in __NEXT_DATA__ —
      // Walmart's JSON has dozens of "name" keys (layout modules, placeholders)
      // and the first match is garbage like "3Grid"/"ProductIngredientsPlaceholder".
      // The clean product title comes from og:title / <title> below.
      if (!brand) {
        const b = /"brand"\s*:\s*"([^"]{1,80})"/.exec(str);
        if (b) brand = decodeEntities(b[1]);
      }
      if (!imageUrl) {
        const img = /"(?:imageUrl|thumbnailUrl|image)"\s*:\s*"(https:[^"]+?\.(?:jpg|jpeg|png|webp)[^"]*)"/.exec(str);
        if (img) imageUrl = img[1].replace(/\\u002F/g, "/");
      }
      if (inStock == null) {
        const av = /"availabilityStatus"\s*:\s*"([^"]+)"/.exec(str);
        if (av) inStock = /IN_STOCK/i.test(av[1]);
      }
    } catch {
      /* fall back to whatever JSON-LD / meta gave us */
    }
  }

  // Clean product title, guarded against Walmart's junk __NEXT_DATA__ "name"
  // fields. Prefer JSON-LD, then og:title, then <title>; store suffix stripped.
  const docTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  title = pickTitle(title, metaContent(html, "og:title"), docTitle);
  imageUrl = imageUrl ?? metaContent(html, "og:image");

  return {
    title: title ?? null,
    brand: brand ?? null,
    imageUrl: imageUrl ?? null,
    price: price ?? null,
    currency: ld?.currency ?? "USD",
    inStock,
    size: parseSize(title),
  };
}

/** Costco / generic: lean on JSON-LD + Open Graph + visible price regex. */
function parseGeneric(html: string): ParsedProduct {
  const ld = parseJsonLd(html);
  let price = ld?.price ?? null;
  if (price == null) {
    const meta = metaContent(html, "product:price:amount") ?? metaContent(html, "og:price:amount");
    if (meta && !isNaN(Number(meta))) price = Number(meta);
  }
  if (price == null) {
    // Common embedded-JSON price keys (Costco, Instacart/Same-Day, generic):
    //   "price":"$4.99" · "priceString":"$4.99" · "formattedPrice":"$4.99"
    //   "price":{"value":4.99} · "amount":4.99 · "salePrice":4.99
    const jsonPatterns: RegExp[] = [
      /"(?:price_?string|formatted_?price|display_?price|priceText)"\s*:\s*"\$?([0-9,]+\.[0-9]{2})"/i,
      /"(?:sale_?price|current_?price|final_?price|your_?price)"\s*:\s*"?\$?([0-9,]+\.[0-9]{2})"?/i,
      /"price"\s*:\s*\{[^}]*?"(?:value|amount)"\s*:\s*"?\$?([0-9,]+\.[0-9]{2})"?/i,
      /"price"\s*:\s*"?\$?([0-9,]+\.[0-9]{2})"?/i,
    ];
    for (const re of jsonPatterns) {
      const m = re.exec(html);
      if (m) { price = parseFloat(m[1].replace(/,/g, "")); break; }
    }
  }
  if (price == null) {
    const dollar = /(?:price|automation-id="productPriceOutput")[^$]{0,80}\$([0-9,]+\.[0-9]{2})/i.exec(html);
    if (dollar) price = parseFloat(dollar[1].replace(/,/g, ""));
  }
  const docTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = pickTitle(ld?.name, metaContent(html, "og:title"), docTitle);
  const imageUrl = ld?.image ?? metaContent(html, "og:image");
  return {
    title: title ?? null,
    brand: ld?.brand ?? null,
    imageUrl: imageUrl ?? null,
    price,
    currency: ld?.currency ?? "USD",
    inStock: ld?.inStock ?? null,
    size: parseSize(title),
  };
}

export function parseProduct(store: Store, html: string): ParsedProduct {
  switch (store) {
    case "amazon":
    case "amazon_fresh":
      return parseAmazon(html);
    case "walmart":
      return parseWalmart(html);
    case "costco":
    case "costco_sameday":
    default:
      return parseGeneric(html);
  }
}

// ── kosher classification (the one fuzzy bit → Claude) ───────────────────────

export interface KosherVerdict {
  status: "kosher" | "not_kosher" | "unclear";
  note: string | null;
}

const KOSHER_SYSTEM = `You judge whether a food/grocery product is kosher-certified from its title, brand and any visible text.
Rules:
- Look for hechsher (kosher certification) marks or words: OU, OK, Star-K, Kof-K, OU-D, OU-P, Chof-K, Triangle-K, "kosher", "parve", "pareve", "כשר", "בד״ץ", "מהדרין".
- If you see a clear certification mark/word, status = "kosher".
- If the product is clearly non-kosher by nature (pork, shellfish, etc.) status = "not_kosher".
- If there is NO certification visible and you cannot be sure, status = "unclear" — do NOT guess kosher.
- Non-food items (cleaning supplies, etc.) → status = "unclear", note = "not a food item".
Return ONLY JSON: {"status":"kosher|not_kosher|unclear","note":"<short reason in Hebrew, max 12 words>"}`;

export async function classifyKosher(
  title: string | null,
  brand: string | null,
  extraText: string,
  userId: string,
): Promise<KosherVerdict> {
  if (!title && !brand) return { status: "unclear", note: null };
  try {
    const { content } = await simpleCall(
      "haiku",
      KOSHER_SYSTEM,
      `Brand: ${brand ?? "?"}\nTitle: ${title ?? "?"}\nExtra: ${extraText.slice(0, 1500)}`,
      256,
      { component: "server.price-tracker.kosher", userId },
    );
    const parsed = parseJsonResponse<KosherVerdict>(content);
    if (parsed && ["kosher", "not_kosher", "unclear"].includes(parsed.status)) {
      return { status: parsed.status, note: parsed.note ?? null };
    }
  } catch {
    /* fall through to unclear */
  }
  return { status: "unclear", note: null };
}

// ── public extraction entry points ───────────────────────────────────────────

export interface PriceRead {
  ok: boolean;
  store: Store;
  url: string;
  price: number | null;
  currency: string;
  pricePerOz: number | null;
  size: ParsedSize | null;
  inStock: boolean | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  viaBrowser: boolean;
  error: string | null;
}

function pricePerOz(price: number | null, size: ParsedSize | null): number | null {
  if (price == null || !size || size.unit !== "oz" || size.value <= 0) return null;
  return +(price / size.value).toFixed(4);
}

/**
 * Read a single product page live. Used both by ingest (first read) and by
 * the comparison run. `sizeOverride` lets the saved catalogue size win when a
 * store page doesn't expose the size (so per-oz still computes).
 */
export async function readPrice(
  url: string,
  storeHint?: Store,
  sizeOverride?: ParsedSize | null,
): Promise<PriceRead> {
  const store = storeHint ?? detectStore(url);
  if (!store) {
    return {
      ok: false, store: "amazon", url, price: null, currency: "USD",
      pricePerOz: null, size: null, inStock: null, title: null,
      brand: null, imageUrl: null, viaBrowser: false, error: "Unsupported store URL",
    };
  }
  try {
    const fetched = await fetchPage(url);
    if (fetched.blocked && !/\$|"price"|a-price/i.test(fetched.html)) {
      const providerOn = !!(process.env.SCRAPER_API_KEY && process.env.SCRAPER_PROVIDER);
      const hint = providerOn
        ? " Try enabling SCRAPER_ULTRA=true (residential tier)."
        : " Set SCRAPER_PROVIDER + SCRAPER_API_KEY to route this store through a scraping proxy.";
      return {
        ok: false, store, url, price: null, currency: "USD", pricePerOz: null,
        size: null, inStock: null, title: null, brand: null, imageUrl: null,
        viaBrowser: fetched.viaBrowser,
        error: `Blocked by ${STORE_LABELS[store]} (anti-bot).${hint}`,
      };
    }
    const parsed = parseProduct(store, fetched.html);
    const size = parsed.size ?? sizeOverride ?? null;
    return {
      ok: parsed.price != null,
      store, url,
      price: parsed.price,
      currency: parsed.currency,
      pricePerOz: pricePerOz(parsed.price, size),
      size,
      inStock: parsed.inStock,
      title: parsed.title,
      brand: parsed.brand,
      imageUrl: parsed.imageUrl,
      viaBrowser: fetched.viaBrowser,
      error: parsed.price == null ? "Page loaded but no price was found" : null,
    };
  } catch (err) {
    return {
      ok: false, store, url, price: null, currency: "USD", pricePerOz: null,
      size: sizeOverride ?? null, inStock: null, title: null, brand: null,
      imageUrl: null, viaBrowser: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── official-API seam (prepared, not yet wired) ──────────────────────────────
//
// Today every store is read by scraping (readPrice above). The stores that
// offer an official, sanctioned API are Amazon and Walmart; Costco has none.
// When the operator opens those accounts, wiring the official path is a
// drop-in: implement the adapter and make officialApiAvailable() return true.
//
//   Amazon  → Product Advertising API 5.0
//             env: AMAZON_PAAPI_KEY, AMAZON_PAAPI_SECRET, AMAZON_PARTNER_TAG
//   Walmart → Walmart.io Affiliate API
//             env: WALMART_API_KEY, WALMART_API_SECRET
//
// resolveSource() is the single decision point both readPrice and findInStore
// consult, so the rest of the engine never needs to know which backend served
// a price.
export type PriceSourceKind = "official" | "scrape";

export function officialApiAvailable(store: Store): boolean {
  // NOTE: returns false until the adapters below are implemented. The env
  // checks document the exact contract; flip each clause on once wired.
  switch (store) {
    case "amazon":
    case "amazon_fresh":
      // return !!(process.env.AMAZON_PAAPI_KEY && process.env.AMAZON_PAAPI_SECRET && process.env.AMAZON_PARTNER_TAG);
      return false;
    case "walmart":
      // return !!(process.env.WALMART_API_KEY && process.env.WALMART_API_SECRET);
      return false;
    default:
      return false; // costco / costco_sameday: no official API exists
  }
}

export function resolveSource(store: Store): PriceSourceKind {
  return officialApiAvailable(store) ? "official" : "scrape";
}

// ── cross-store search + match (card = product, not product-in-a-store) ──────

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

// Which URLs on each store are actual product pages (not category/search).
const PRODUCT_URL_RE: Record<Store, RegExp> = {
  amazon: /amazon\.com\/(?:[^?#]*\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i,
  amazon_fresh: /amazon\.com\/(?:[^?#]*\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i,
  walmart: /walmart\.com\/ip\//i,
  costco: /costco\.com\/[^?#]*\.(?:product\.\d+\.)?html/i,
  // Costco Same-Day is Instacart-powered but should point at Costco's own
  // branded storefront (sameday.costco.com), not the generic instacart.com.
  // Only real product pages — not "/store/s?k=…" search or "…-near-me" SEO
  // pages, which 403 and carry no price.
  costco_sameday: /sameday\.costco\.com\/(?:store\/)?(?:[^/]+\/)?products\/\d+/i,
};

const STORE_SEARCH_DOMAIN: Record<Store, string> = {
  amazon: "amazon.com",
  amazon_fresh: "amazon.com",
  walmart: "walmart.com",
  costco: "costco.com",
  costco_sameday: "sameday.costco.com",
};

/**
 * Web search via Jina (s.jina.ai). Returns [] when JINA_API_KEY is unset —
 * the search endpoint requires a (free) key, unlike the reader. This is the
 * one piece of the auto-discovery flow that needs the key.
 */
export async function jinaSearch(query: string): Promise<SearchHit[]> {
  const key = process.env.JINA_API_KEY;
  if (!key) return [];
  try {
    const resp = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "X-Respond-With": "no-content",
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) return [];
    const json = (await resp.json().catch(() => null)) as
      | { data?: Array<{ url?: string; title?: string; description?: string }> }
      | null;
    return (json?.data ?? [])
      .filter((d) => typeof d.url === "string")
      .map((d) => ({ url: d.url as string, title: d.title ?? "", description: d.description ?? "" }));
  } catch {
    return [];
  }
}

const MATCH_SYSTEM = `You match a reference grocery/household product to the SAME product on another store.
DIFFERENT sizes/packs of the same product ARE matches and you WANT them all
(e.g. 12oz, 18oz, and a 2-pack are three valid matches) — the goal is to find
the cheapest per-ounce across sizes. A DIFFERENT flavor, brand, or a
fundamentally different item is NOT a match.
You are given the reference product and a numbered candidate list from one store.
Return the indices of ALL candidates that are the same product in ANY size.
Return ONLY JSON: {"indices": [<numbers>], "reason": "<short>"}`;

/**
 * Find the same product on a given store, across ALL sizes/packs, so the
 * caller can read each and keep the cheapest per-ounce. Searches the web
 * (scoped to the store), filters to real product URLs, and asks Claude which
 * candidates are the same product in any size. Returns up to `limit` matches.
 */
export async function findInStore(
  canonical: { name: string; brand: string | null; sizeLabel: string | null },
  store: Store,
  userId: string,
  limit = 3,
): Promise<Array<{ url: string; title: string }>> {
  // Build a clean keyword query: brand + name, without repeating the brand if
  // the name already starts with it. Drop trailing pack/size noise — search
  // engines match the core product better without "(Pack of 4)".
  const name = canonical.name.replace(/\s*\(pack of[^)]*\)/i, "").trim();
  const brand = canonical.brand?.trim() ?? "";
  const core = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${name}`
    : name;

  // Two passes: scoped `site:` first, then a domain keyword fallback. Jina's
  // SERP sometimes drops site:-scoped results, so the fallback filters by URL.
  // Dedupe by URL so the same product page isn't read twice.
  let candidates: SearchHit[] = [];
  for (const q of [`${core} site:${STORE_SEARCH_DOMAIN[store]}`, `${core} ${STORE_LABELS[store]}`]) {
    const hits = await jinaSearch(q);
    candidates = hits.filter((h) => PRODUCT_URL_RE[store].test(h.url));
    if (candidates.length) break;
  }
  const seen = new Set<string>();
  candidates = candidates.filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, 8);

  const clean = (s: string) => stripStoreSuffix(decodeEntities(s));
  if (!candidates.length) return [];
  if (candidates.length === 1) return [{ url: candidates[0].url, title: clean(candidates[0].title) }];

  try {
    const list = candidates.map((c, i) => `${i}. ${c.title} — ${c.url}`).join("\n");
    const { content } = await simpleCall(
      "haiku",
      MATCH_SYSTEM,
      `Reference product:\n  Brand: ${canonical.brand ?? "?"}\n  Name: ${canonical.name}\n  Size: ${canonical.sizeLabel ?? "?"}\n\nCandidates on ${STORE_LABELS[store]}:\n${list}`,
      256,
      { component: "server.price-tracker.match", userId },
    );
    const parsed = parseJsonResponse<{ indices: number[] }>(content);
    const idxs = Array.isArray(parsed?.indices) ? parsed!.indices : [];
    const picked = idxs
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      .slice(0, limit)
      .map((i) => ({ url: candidates[i].url, title: clean(candidates[i].title) }));
    return picked;
  } catch {
    /* fall through */
  }
  return [];
}

/** Is cross-store auto-discovery available (i.e. is the search key set)? */
export function searchAvailable(): boolean {
  return !!process.env.JINA_API_KEY;
}
