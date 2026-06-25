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
 * Fetch a page, escalating from raw GET to a real browser only when the
 * cheap path is blocked. Never throws on a browser-unavailable env — the
 * raw result (with blocked=true) is returned so the caller can report it.
 */
export async function fetchPage(url: string): Promise<FetchResult> {
  let raw: FetchResult | null = null;
  try {
    raw = await rawFetch(url);
    if (!raw.blocked) return raw;
  } catch {
    /* fall through to the browser attempt */
  }
  try {
    const viaBrowser = await browserFetch(url);
    // If the browser also came back blocked but the raw fetch had more
    // content, prefer whichever has real markup.
    if (!viaBrowser.blocked) return viaBrowser;
    if (raw && raw.html.length > viaBrowser.html.length) return raw;
    return viaBrowser;
  } catch {
    if (raw) return raw;
    return { html: "", status: 0, blocked: true, viaBrowser: false };
  }
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

  // "N-pack" / "N pack" combined with a single size elsewhere in the string
  const packMatch = /(\d+)\s*-?\s*(?:pack|pk|count|ct)\b/i.exec(t);
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
  const title =
    (/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] &&
      decodeEntities(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)![1].replace(/<[^>]+>/g, " "))) ||
    metaContent(html, "title") ||
    (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(html)![1]) : null);

  // Buybox price: the first a-offscreen $ value inside the core price block,
  // or the a-price-whole + fraction pair.
  let price: number | null = null;
  const offscreen = /id=["']corePriceDisplay[\s\S]{0,400}?<span class=["']a-offscreen["']>\$([0-9,]+\.[0-9]{2})/i.exec(html)
    ?? /<span class=["']a-offscreen["']>\$([0-9,]+\.[0-9]{2})/i.exec(html);
  if (offscreen) price = parseFloat(offscreen[1].replace(/,/g, ""));
  if (price == null) {
    const whole = /<span class=["']a-price-whole["']>([0-9,]+)/i.exec(html);
    const frac = /<span class=["']a-price-fraction["']>([0-9]{2})/i.exec(html);
    if (whole) price = parseFloat(`${whole[1].replace(/,/g, "")}.${frac ? frac[1] : "00"}`);
  }

  const brand =
    (/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1]
      ? decodeEntities(/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)![1].replace(/<[^>]+>/g, " "))
          .replace(/^(visit the|brand:)\s*/i, "")
          .replace(/\s*store$/i, "")
      : null);

  const imageUrl =
    /id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i.exec(html)?.[1] ||
    /id=["']landingImage["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ||
    metaContent(html, "og:image");

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
      if (!title) {
        const n = /"name"\s*:\s*"([^"]{4,200})"/.exec(str);
        if (n) title = decodeEntities(n[1]);
      }
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

  title = title ?? metaContent(html, "og:title");
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
    const dollar = /(?:price|automation-id="productPriceOutput")[^$]{0,80}\$([0-9,]+\.[0-9]{2})/i.exec(html);
    if (dollar) price = parseFloat(dollar[1].replace(/,/g, ""));
  }
  const title = ld?.name ?? metaContent(html, "og:title") ?? (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(html)![1]) : null);
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
      return {
        ok: false, store, url, price: null, currency: "USD", pricePerOz: null,
        size: null, inStock: null, title: null, brand: null, imageUrl: null,
        viaBrowser: fetched.viaBrowser,
        error: `Blocked by ${STORE_LABELS[store]} (anti-bot). No price could be read.`,
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
