/**
 * Admin: price tracker — a personal price-per-ounce comparison tool.
 * Every route is gated by requireAuth + requireSuperAdmin.
 *
 * Flow:
 *   1. Operator pastes a product URL  → POST /ingest  → we read the page,
 *      detect brand/size/image, judge kosher, and save it to the catalogue.
 *   2. Optionally add the same product's link in other stores.
 *   3. Select products → POST /check → we read every store link live and
 *      return a per-oz comparison, cheapest first.
 *
 * Saved data lives in price_products / price_product_links / price_checks.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireSuperAdmin } from "../../../middleware";
import { db } from "../../../db";
import {
  detectStore,
  readPrice,
  classifyKosher,
  findInStore,
  searchAvailable,
  extractConcept,
  findSubstitutes,
  STORE_LABELS,
  type Store,
  type ParsedSize,
  type ProductConcept,
} from "./extract";

type Prefs = { kosher_only: boolean; substitution_level: "off" | "exact" | "close" | "loose" };

async function loadPrefs(userId: string): Promise<Prefs> {
  const { data } = await db
    .from("price_user_prefs")
    .select("kosher_only, substitution_level")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    kosher_only: data?.kosher_only ?? true,
    substitution_level: (data?.substitution_level as Prefs["substitution_level"]) ?? "close",
  };
}

/** Load the cached product concept, or extract+cache it. Returns AI cost too. */
async function loadOrExtractConcept(
  product: { id: string; name: string; brand: string | null },
  userId: string,
): Promise<{ concept: ProductConcept | null; costUsd: number }> {
  const { data } = await db
    .from("price_product_concepts")
    .select("*")
    .eq("product_id", product.id)
    .maybeSingle();
  if (data) {
    return {
      concept: {
        category: data.category ?? "",
        subtype: data.subtype ?? "",
        flavor: data.flavor ?? null,
        diet: Array.isArray(data.diet) ? data.diet : [],
        keyIngredients: Array.isArray(data.key_ingredients) ? data.key_ingredients : [],
        searchTerms: Array.isArray(data.search_terms) ? data.search_terms : [],
      },
      costUsd: 0,
    };
  }
  const { concept, costUsd } = await extractConcept(product.name, product.brand, userId);
  if (concept) {
    const { error } = await db.from("price_product_concepts").insert({
      product_id: product.id,
      category: concept.category, subtype: concept.subtype, flavor: concept.flavor,
      diet: concept.diet, key_ingredients: concept.keyIngredients, search_terms: concept.searchTerms,
    });
    if (error) console.error("[price-tracker] concept cache failed:", error.message);
  }
  return { concept, costUsd };
}

const router = Router();

const STORES: Store[] = ["amazon", "amazon_fresh", "walmart", "costco", "costco_sameday"];

interface ProductRow {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  image_url: string | null;
  size_value: number | null;
  size_unit: string | null;
  size_label: string | null;
  kosher_status: string;
  kosher_note: string | null;
  source_url: string | null;
  source_store: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  product_id: string;
  store: string;
  url: string;
  auto_matched?: boolean;
  matched_title?: string | null;
}

/** Load every product (with its store links) for the requesting operator. */
async function loadCatalogue(userId: string) {
  const { data: products, error } = await db
    .from("price_products")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`load products: ${error.message}`);

  const ids = (products ?? []).map((p) => (p as ProductRow).id);
  let links: LinkRow[] = [];
  if (ids.length) {
    const { data: linkRows, error: linkErr } = await db
      .from("price_product_links")
      .select("*")
      .in("product_id", ids);
    if (linkErr) throw new Error(`load links: ${linkErr.message}`);
    links = (linkRows ?? []) as LinkRow[];
  }

  return (products ?? []).map((p) => {
    const row = p as ProductRow;
    return {
      ...row,
      links: links.filter((l) => l.product_id === row.id),
    };
  });
}

// ── ingest a single product from a URL ───────────────────────────────────────

async function ingestUrl(userId: string, rawUrl: string) {
  const url = rawUrl.trim();
  const store = detectStore(url);
  if (!store) {
    return { ok: false as const, url, error: "Unsupported store URL" };
  }

  const read = await readPrice(url, store);

  // We still save the product even if the price read was blocked — the
  // operator wants it in the list; the price just shows as "unknown" until a
  // future check (or a manual store-link) succeeds.
  const kosher = await classifyKosher(read.title, read.brand, read.title ?? "", userId);

  const size: ParsedSize | null = read.size;
  const name = read.title ?? url;

  const { data: inserted, error } = await db
    .from("price_products")
    .insert({
      user_id: userId,
      name,
      brand: read.brand,
      image_url: read.imageUrl,
      size_value: size?.value ?? null,
      size_unit: size?.unit ?? null,
      size_label: size?.label ?? null,
      kosher_status: kosher.status,
      kosher_note: kosher.note,
      source_url: url,
      source_store: store,
    })
    .select("*")
    .single();

  if (error) return { ok: false as const, url, error: `save failed: ${error.message}` };

  const product = inserted as ProductRow;

  // First store link.
  const { error: linkErr } = await db
    .from("price_product_links")
    .insert({ product_id: product.id, store, url });
  if (linkErr) console.error("[price-tracker] link insert failed:", linkErr.message);

  return { ok: true as const, url, productId: product.id, read, kosherCostUsd: kosher.costUsd };
}

router.post("/admin/price-tracker/ingest", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const result = await ingestUrl(req.user!.id, url);
    if (!result.ok) return res.status(422).json({ error: result.error });
    const catalogue = await loadCatalogue(req.user!.id);
    const product = catalogue.find((p) => p.id === result.productId);
    if (!product) return res.status(500).json({ error: "product vanished after insert" });
    // Auto-run the comparison so adding a product immediately shows prices
    // across every store — no separate "Run comparison" click needed.
    const comparison = await compareProduct(product, req.user!.id, await loadPrefs(req.user!.id));
    // fold the one-time kosher-classification cost into this add's AI total
    comparison.aiCost = +(comparison.aiCost + (result.kosherCostUsd ?? 0)).toFixed(6);
    return res.json({ product, comparison });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] ingest failed:", err);
    return res.status(500).json({ error: msg });
  }
});

// Add a product by typing its NAME (no URL). We search for it — preferring
// Amazon (cleanest titles), then Walmart, then Costco — ingest the first real
// match as the canonical product, then auto-run the cross-store comparison.
router.post("/admin/price-tracker/ingest-by-name", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!searchAvailable()) {
    return res.status(422).json({ error: "Search by name needs JINA_API_KEY (set it in Railway)." });
  }

  try {
    const canonical = { name, brand: null, sizeLabel: null };
    let sourceUrl: string | null = null;
    for (const store of ["amazon", "walmart", "costco"] as Store[]) {
      const { matches } = await findInStore(canonical, store, req.user!.id, 1);
      if (matches.length) { sourceUrl = matches[0].url; break; }
    }
    if (!sourceUrl) return res.status(422).json({ error: `No product found for "${name}"` });

    const result = await ingestUrl(req.user!.id, sourceUrl);
    if (!result.ok) return res.status(422).json({ error: result.error });
    const catalogue = await loadCatalogue(req.user!.id);
    const product = catalogue.find((p) => p.id === result.productId);
    if (!product) return res.status(500).json({ error: "product vanished after insert" });
    const comparison = await compareProduct(product, req.user!.id, await loadPrefs(req.user!.id));
    comparison.aiCost = +(comparison.aiCost + (result.kosherCostUsd ?? 0)).toFixed(6);
    return res.json({ product, comparison });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] ingest-by-name failed:", err);
    return res.status(500).json({ error: msg });
  }
});

router.post("/admin/price-tracker/bulk-ingest", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const urls = Array.isArray(req.body?.urls) ? (req.body.urls as unknown[]) : [];
  const clean = urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0).map((u) => u.trim());
  if (!clean.length) return res.status(400).json({ error: "urls[] is required" });
  if (clean.length > 50) return res.status(400).json({ error: "Too many URLs (max 50 per upload)" });

  const results: Array<{ url: string; ok: boolean; error?: string }> = [];
  // Sequential on purpose: each ingest may launch a browser; running 50 in
  // parallel would exhaust memory on the backend dyno.
  for (const url of clean) {
    try {
      const r = await ingestUrl(req.user!.id, url);
      results.push({ url, ok: r.ok, error: r.ok ? undefined : r.error });
    } catch (err) {
      results.push({ url, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    const catalogue = await loadCatalogue(req.user!.id);
    return res.json({ results, products: catalogue });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), results });
  }
});

router.get("/admin/price-tracker/products", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const products = await loadCatalogue(req.user!.id);
    return res.json({ products });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/admin/price-tracker/products/:id", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const { error } = await db
    .from("price_products")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// re-read the product's source URL and update name/brand/image/size/kosher in
// place — handy after a parser fix, without forcing delete + re-add.
router.post("/admin/price-tracker/products/:id/refresh", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const { data: row } = await db
    .from("price_products")
    .select("id, source_url, source_store")
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (!row) return res.status(404).json({ error: "product not found" });
  const product = row as Pick<ProductRow, "id" | "source_url" | "source_store">;
  if (!product.source_url) return res.status(422).json({ error: "no source URL to refresh from" });

  try {
    const read = await readPrice(product.source_url, (product.source_store as Store) ?? undefined);

    // Non-destructive: only overwrite a field when the re-read actually
    // produced a value. A blocked/rate-limited read must NEVER replace a good
    // name with the URL or wipe the image.
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (read.title) update.name = read.title;       // parser already cleaned/guarded it
    if (read.brand) update.brand = read.brand;
    if (read.imageUrl) update.image_url = read.imageUrl;
    if (read.size) {
      update.size_value = read.size.value;
      update.size_unit = read.size.unit;
      update.size_label = read.size.label;
    }
    if (read.title) {
      const kosher = await classifyKosher(read.title, read.brand, read.title, req.user!.id);
      update.kosher_status = kosher.status;
      update.kosher_note = kosher.note;
    }

    const refreshedAnything = Object.keys(update).length > 1;
    if (refreshedAnything) {
      const { error } = await db.from("price_products").update(update).eq("id", product.id);
      if (error) return res.status(500).json({ error: error.message });
    }
    const catalogue = await loadCatalogue(req.user!.id);
    return res.json({
      product: catalogue.find((p) => p.id === product.id),
      warning: refreshedAnything ? undefined : (read.error ?? "Could not read the source page (kept existing data)"),
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// add / replace a store link for a product
router.post("/admin/price-tracker/products/:id/links", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const store = req.body?.store as Store;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!STORES.includes(store)) return res.status(400).json({ error: "invalid store" });
  if (!url) return res.status(400).json({ error: "url is required" });

  // verify ownership
  const { data: owned } = await db
    .from("price_products")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (!owned) return res.status(404).json({ error: "product not found" });

  const { error } = await db
    .from("price_product_links")
    .upsert({ product_id: req.params.id, store, url }, { onConflict: "product_id,store" });
  if (error) return res.status(500).json({ error: error.message });

  const catalogue = await loadCatalogue(req.user!.id);
  return res.json({ product: catalogue.find((p) => p.id === req.params.id) });
});

router.delete("/admin/price-tracker/products/:id/links/:store", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  // Ownership guard — the service-role client bypasses RLS, so without this a
  // super-admin could delete another operator's links by guessing a product id.
  const { data: owned } = await db
    .from("price_products")
    .select("id")
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (!owned) return res.status(404).json({ error: "product not found" });

  const { error } = await db
    .from("price_product_links")
    .delete()
    .eq("product_id", req.params.id)
    .eq("store", req.params.store);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ── run a live comparison ────────────────────────────────────────────────────

interface CompRow {
  store: Store;
  storeLabel: string;
  found: boolean;        // did we have/discover a link for this store?
  url: string | null;
  matchedTitle: string | null; // the product's title on this store (size may differ)
  ok: boolean;
  price: number | null;
  currency: string;
  pricePerOz: number | null;
  sizeLabel: string | null;
  inStock: boolean | null;
  isCheapest: boolean;   // tie-aware: every store at the lowest per-oz is true
  differentSize: boolean; // the matched size differs from the canonical product
  error: string | null;
}

interface AlternativeRow {
  store: Store;
  storeLabel: string;
  url: string;
  title: string;            // the alternative product (different brand)
  tier: "close" | "loose";
  kosher: "kosher" | "not_kosher" | "unclear";
  price: number | null;
  currency: string;
  pricePerOz: number | null;
  sizeLabel: string | null;
  inStock: boolean | null;
  isCheapest: boolean;
  error: string | null;
}

interface Comparison {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  sizeLabel: string | null;
  kosherStatus: string;
  kosherNote: string | null;
  rows: CompRow[];
  alternatives: AlternativeRow[]; // same kind of product, OTHER brands
  cheapestStore: Store | null;
  searchEnabled: boolean;
  aiCost: number; // real AI $ spent on this comparison (from token usage)
}

/**
 * Compare a single product across every store. The card is the PRODUCT — for
 * each store we use a cached link if we have one, otherwise auto-discover the
 * same product via search (allowing size/pack differences) and cache the hit.
 * Each store's own page size drives its per-oz, so different pack sizes still
 * compare fairly.
 */
async function compareProduct(
  product: Awaited<ReturnType<typeof loadCatalogue>>[number],
  userId: string,
  prefs: Prefs,
): Promise<Comparison> {
  const canonical = {
    name: product.name,
    brand: product.brand,
    sizeLabel: product.size_label,
  };
  const cachedByStore = new Map<Store, LinkRow>();
  for (const l of product.links) cachedByStore.set(l.store as Store, l as LinkRow);

  // Collect any product image seen across stores so a product missing its own
  // image can be backfilled (every store usually carries one).
  const foundImages: string[] = [];
  const aiCosts: number[] = []; // real AI cost accrued by store matching

  const rows = await Promise.all(
    STORES.map(async (store): Promise<CompRow> => {
      const base: CompRow = {
        store, storeLabel: STORE_LABELS[store], found: false, url: null,
        matchedTitle: null, ok: false, price: null, currency: "USD",
        pricePerOz: null, sizeLabel: null, inStock: null, isCheapest: false,
        differentSize: false, error: null,
      };

      try {
      // 1. gather candidate URLs for this store. A cached link reads just that
      //    one (fast re-checks); a fresh product discovers the SAME product in
      //    ALL sizes so we can keep whichever is cheapest per ounce.
      const cached = cachedByStore.get(store);
      let candidates: Array<{ url: string; title: string | null }>;
      if (cached) {
        candidates = [{ url: cached.url, title: cached.matched_title ?? null }];
      } else if (searchAvailable()) {
        const found = await findInStore(canonical, store, userId);
        candidates = found.matches;
        aiCosts.push(found.costUsd);
      } else {
        return { ...base, error: "Auto-search needs JINA_API_KEY" };
      }
      if (!candidates.length) return { ...base, error: "Product not found in this store" };

      // 2. read every candidate's live price, log each, then keep the cheapest
      //    per-oz (each size compared on its own ounces — a fair comparison).
      const reads = await Promise.all(
        candidates.map(async (c) => {
          const r = await readPrice(c.url, store);
          const { error: logErr } = await db.from("price_checks").insert({
            product_id: product.id, store, url: c.url,
            ok: r.ok, price: r.price, currency: r.currency,
            size_value: r.size?.value ?? null, size_unit: r.size?.unit ?? null,
            size_label: r.size?.label ?? null, price_per_oz: r.pricePerOz,
            in_stock: r.inStock, raw_title: r.title, error: r.error,
          });
          if (logErr) console.error("[price-tracker] check log failed:", logErr.message);
          return { c, r };
        }),
      );

      const ranked = reads
        .filter((x) => x.r.ok && x.r.pricePerOz != null)
        .sort((a, b) => a.r.pricePerOz! - b.r.pricePerOz!);
      const chosen = ranked[0] ?? reads.find((x) => x.r.ok) ?? reads[0];
      const { c, r: read } = chosen;
      const matchedTitle = c.title ?? read.title;
      if (read.imageUrl) foundImages.push(read.imageUrl);

      // Flag when the cheapest match is a different size/pack than the product
      // the operator saved — so a "different size" badge can explain the deal.
      const canonOz = product.size_value != null ? Number(product.size_value) : null;
      const differentSize =
        canonOz != null && read.size != null &&
        (read.size.unit !== product.size_unit || Math.abs(read.size.value - canonOz) > canonOz * 0.02);

      // cache the chosen (cheapest) match so re-checks are fast
      if (!cached || cached.url !== c.url) {
        const { error: upErr } = await db
          .from("price_product_links")
          .upsert(
            { product_id: product.id, store, url: c.url, auto_matched: !cached, matched_title: matchedTitle },
            { onConflict: "product_id,store" },
          );
        if (upErr) console.error("[price-tracker] match cache failed:", upErr.message);
      }

      return {
        ...base,
        found: true,
        url: c.url,
        matchedTitle,
        ok: read.ok,
        price: read.price,
        currency: read.currency,
        pricePerOz: read.pricePerOz,
        sizeLabel: read.size?.label ?? null,
        inStock: read.inStock,
        differentSize,
        error: read.error,
      };
      } catch (err) {
        // Degrade one store to an error row — never fail the whole batch.
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Crown cheapest only on a true per-oz basis; never across mismatched sizes.
  // Tie-aware: every store at (or within a cent-fraction of) the lowest per-oz
  // is flagged, so two stores at the same price are both marked cheapest.
  const perOz = rows.filter((r) => r.ok && r.pricePerOz != null).map((r) => r.pricePerOz!);
  const minOz = perOz.length ? Math.min(...perOz) : null;
  if (minOz != null) {
    for (const r of rows) {
      if (r.ok && r.pricePerOz != null && Math.abs(r.pricePerOz - minOz) < 0.0005) r.isCheapest = true;
    }
  }

  // Backfill the product image from any store that had one.
  let imageUrl = product.image_url;
  if (!imageUrl && foundImages.length) {
    imageUrl = foundImages[0];
    const { error } = await db.from("price_products").update({ image_url: imageUrl }).eq("id", product.id);
    if (error) console.error("[price-tracker] image backfill failed:", error.message);
  }

  // ── substitutes: same kind of product, OTHER brands (cheaper alternative) ──
  let alternatives: AlternativeRow[] = [];
  if (prefs.substitution_level !== "off" && searchAvailable()) {
    const { concept, costUsd: conceptCost } = await loadOrExtractConcept(product, userId);
    aiCosts.push(conceptCost);
    if (concept) {
      const perStore = await Promise.all(
        STORES.map((store) =>
          findSubstitutes(concept, product.brand, store,
            { kosherOnly: prefs.kosher_only, level: prefs.substitution_level as "exact" | "close" | "loose" }, userId)
            .catch(() => ({ alts: [], costUsd: 0 })),
        ),
      );
      perStore.forEach((p) => aiCosts.push(p.costUsd));
      const hits = perStore.flatMap((p) => p.alts).slice(0, 8); // cap reads
      const read = await Promise.all(
        hits.map(async (h) => {
          try { return { h, r: await readPrice(h.url, h.store) }; }
          catch (e) { return { h, r: null, err: e instanceof Error ? e.message : String(e) }; }
        }),
      );
      alternatives = read.map(({ h, r, err }: { h: typeof hits[number]; r: Awaited<ReturnType<typeof readPrice>> | null; err?: string }) => ({
        store: h.store, storeLabel: STORE_LABELS[h.store], url: h.url, title: h.title,
        tier: h.tier, kosher: h.kosher,
        price: r?.price ?? null, currency: r?.currency ?? "USD",
        pricePerOz: r?.pricePerOz ?? null, sizeLabel: r?.size?.label ?? null,
        inStock: r?.inStock ?? null, isCheapest: false, error: r?.error ?? err ?? null,
      }));
      const okOz = alternatives.filter((a) => a.pricePerOz != null).map((a) => a.pricePerOz!);
      if (okOz.length) {
        const min = Math.min(...okOz);
        for (const a of alternatives) if (a.pricePerOz != null && Math.abs(a.pricePerOz - min) < 0.0005) a.isCheapest = true;
      }
      alternatives.sort((a, b) => (a.pricePerOz ?? Infinity) - (b.pricePerOz ?? Infinity));
    }
  }

  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    imageUrl,
    sizeLabel: product.size_label,
    kosherStatus: product.kosher_status,
    kosherNote: product.kosher_note,
    rows,
    alternatives,
    cheapestStore: rows.find((r) => r.isCheapest)?.store ?? null,
    searchEnabled: searchAvailable(),
    aiCost: +aiCosts.reduce((a, b) => a + b, 0).toFixed(6),
  };
}

router.post("/admin/price-tracker/check", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.productIds)
    ? (req.body.productIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (!ids.length) return res.status(400).json({ error: "productIds[] is required" });

  try {
    const catalogue = await loadCatalogue(req.user!.id);
    const selected = catalogue.filter((p) => ids.includes(p.id));
    const prefs = await loadPrefs(req.user!.id);
    // One product at a time: each fans out to up to 5 stores (search + read),
    // so per-product parallelism is plenty without hammering Jina's rate limit.
    const comparisons: Comparison[] = [];
    for (const product of selected) {
      comparisons.push(await compareProduct(product, req.user!.id, prefs));
    }
    const totalAiCost = +comparisons.reduce((s, c) => s + c.aiCost, 0).toFixed(6);
    return res.json({ comparisons, totalAiCost });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] check failed:", err);
    return res.status(500).json({ error: msg });
  }
});

// Preferences: kosher-only toggle + substitution aggressiveness.
router.get("/admin/price-tracker/prefs", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  return res.json({ prefs: await loadPrefs(req.user!.id) });
});

router.put("/admin/price-tracker/prefs", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const kosherOnly = typeof req.body?.kosher_only === "boolean" ? req.body.kosher_only : undefined;
  const level = req.body?.substitution_level;
  const validLevels = ["off", "exact", "close", "loose"];
  const patch: Record<string, unknown> = { user_id: req.user!.id, updated_at: new Date().toISOString() };
  if (kosherOnly !== undefined) patch.kosher_only = kosherOnly;
  if (typeof level === "string" && validLevels.includes(level)) patch.substitution_level = level;

  const { error } = await db.from("price_user_prefs").upsert(patch, { onConflict: "user_id" });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ prefs: await loadPrefs(req.user!.id) });
});

// Running AI-cost meter: real $ spent on this tool's AI calls, from the
// ai_usage ledger (today / 7-day / 30-day / all-time), for this operator.
router.get("/admin/price-tracker/ai-cost", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { data, error } = await db
      .from("ai_usage")
      .select("cost_usd, created_at")
      .eq("user_id", req.user!.id)
      .like("component", "server.price-tracker%");
    if (error) return res.status(500).json({ error: error.message });

    const now = Date.now();
    const DAY = 86_400_000;
    const rows = (data ?? []) as Array<{ cost_usd: number | null; created_at: string }>;
    const sumSince = (ms: number) =>
      +rows
        .filter((r) => now - new Date(r.created_at).getTime() <= ms)
        .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
        .toFixed(6);

    return res.json({
      today: sumSince(DAY),
      week: sumSince(7 * DAY),
      month: sumSince(30 * DAY),
      allTime: +rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0).toFixed(6),
      calls: rows.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
