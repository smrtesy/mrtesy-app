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
  STORE_LABELS,
  type Store,
  type ParsedSize,
} from "./extract";

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

  return { ok: true as const, url, productId: product.id, read };
}

router.post("/admin/price-tracker/ingest", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const result = await ingestUrl(req.user!.id, url);
    if (!result.ok) return res.status(422).json({ error: result.error });
    const catalogue = await loadCatalogue(req.user!.id);
    const product = catalogue.find((p) => p.id === result.productId);
    return res.json({ product });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] ingest failed:", err);
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
    const kosher = await classifyKosher(read.title, read.brand, read.title ?? "", req.user!.id);
    const { error } = await db
      .from("price_products")
      .update({
        name: read.title ?? product.source_url,
        brand: read.brand,
        image_url: read.imageUrl,
        size_value: read.size?.value ?? null,
        size_unit: read.size?.unit ?? null,
        size_label: read.size?.label ?? null,
        kosher_status: kosher.status,
        kosher_note: kosher.note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", product.id);
    if (error) return res.status(500).json({ error: error.message });
    const catalogue = await loadCatalogue(req.user!.id);
    return res.json({ product: catalogue.find((p) => p.id === product.id) });
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
  cheapestStore: Store | null;
  searchEnabled: boolean;
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
): Promise<Comparison> {
  const canonical = {
    name: product.name,
    brand: product.brand,
    sizeLabel: product.size_label,
  };
  const cachedByStore = new Map<Store, LinkRow>();
  for (const l of product.links) cachedByStore.set(l.store as Store, l as LinkRow);

  const rows = await Promise.all(
    STORES.map(async (store): Promise<CompRow> => {
      const base: CompRow = {
        store, storeLabel: STORE_LABELS[store], found: false, url: null,
        matchedTitle: null, ok: false, price: null, currency: "USD",
        pricePerOz: null, sizeLabel: null, inStock: null, error: null,
      };

      try {
      // 1. resolve a URL for this store — cached link, else auto-discover
      let url = cachedByStore.get(store)?.url ?? null;
      let matchedTitle = cachedByStore.get(store)?.matched_title ?? null;
      if (!url) {
        if (!searchAvailable()) {
          return { ...base, error: "Auto-search needs JINA_API_KEY" };
        }
        const match = await findInStore(canonical, store, userId);
        if (!match) return { ...base, error: "Product not found in this store" };
        url = match.url;
        matchedTitle = match.title || null;
        // cache the discovered match for next time
        const { error: upErr } = await db
          .from("price_product_links")
          .upsert(
            { product_id: product.id, store, url, auto_matched: true, matched_title: matchedTitle },
            { onConflict: "product_id,store" },
          );
        if (upErr) console.error("[price-tracker] match cache failed:", upErr.message);
      }

      // 2. read the live price from that URL (each store's own size → fair per-oz)
      const read = await readPrice(url, store);
      const { error: logErr } = await db.from("price_checks").insert({
        product_id: product.id, store, url,
        ok: read.ok, price: read.price, currency: read.currency,
        size_value: read.size?.value ?? null, size_unit: read.size?.unit ?? null,
        size_label: read.size?.label ?? null, price_per_oz: read.pricePerOz,
        in_stock: read.inStock, raw_title: read.title, error: read.error,
      });
      if (logErr) console.error("[price-tracker] check log failed:", logErr.message);

      return {
        ...base,
        found: true,
        url,
        matchedTitle: matchedTitle ?? read.title,
        ok: read.ok,
        price: read.price,
        currency: read.currency,
        pricePerOz: read.pricePerOz,
        sizeLabel: read.size?.label ?? null,
        inStock: read.inStock,
        error: read.error,
      };
      } catch (err) {
        // Degrade one store to an error row — never fail the whole batch.
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Crown a cheapest only on a true per-oz basis; never across mismatched sizes.
  const ranked = rows
    .filter((r) => r.ok && r.pricePerOz != null)
    .sort((a, b) => a.pricePerOz! - b.pricePerOz!);

  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    imageUrl: product.image_url,
    sizeLabel: product.size_label,
    kosherStatus: product.kosher_status,
    kosherNote: product.kosher_note,
    rows,
    cheapestStore: ranked[0]?.store ?? null,
    searchEnabled: searchAvailable(),
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
    // One product at a time: each fans out to up to 5 stores (search + read),
    // so per-product parallelism is plenty without hammering Jina's rate limit.
    const comparisons: Comparison[] = [];
    for (const product of selected) {
      comparisons.push(await compareProduct(product, req.user!.id));
    }
    return res.json({ comparisons });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] check failed:", err);
    return res.status(500).json({ error: msg });
  }
});

export default router;
