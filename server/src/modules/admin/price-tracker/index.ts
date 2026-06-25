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

interface Comparison {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  sizeLabel: string | null;
  kosherStatus: string;
  kosherNote: string | null;
  rows: Array<{
    store: Store;
    storeLabel: string;
    url: string;
    ok: boolean;
    price: number | null;
    currency: string;
    pricePerOz: number | null;
    sizeLabel: string | null;
    inStock: boolean | null;
    error: string | null;
  }>;
  cheapestStore: Store | null;
}

router.post("/admin/price-tracker/check", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.productIds)
    ? (req.body.productIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (!ids.length) return res.status(400).json({ error: "productIds[] is required" });

  try {
    const catalogue = await loadCatalogue(req.user!.id);
    const selected = catalogue.filter((p) => ids.includes(p.id));

    const comparisons: Comparison[] = [];

    for (const product of selected) {
      const savedSize: ParsedSize | null =
        product.size_value != null && product.size_unit
          ? { value: Number(product.size_value), unit: product.size_unit as "oz" | "count", label: product.size_label ?? "" }
          : null;

      // Read each store link live, in parallel per product.
      const reads = await Promise.all(
        product.links.map(async (link) => {
          const read = await readPrice(link.url, link.store as Store, savedSize);
          // persist the check — awaited so the history isn't lost if the dyno
          // is recycled right after the response; best-effort on error.
          const { error: logErr } = await db.from("price_checks").insert({
            product_id: product.id,
            store: link.store,
            url: link.url,
            ok: read.ok,
            price: read.price,
            currency: read.currency,
            size_value: read.size?.value ?? null,
            size_unit: read.size?.unit ?? null,
            size_label: read.size?.label ?? null,
            price_per_oz: read.pricePerOz,
            in_stock: read.inStock,
            raw_title: read.title,
            error: read.error,
          });
          if (logErr) console.error("[price-tracker] check log failed:", logErr.message);
          return { link, read };
        }),
      );

      const rows = reads.map(({ link, read }) => ({
        store: link.store as Store,
        storeLabel: STORE_LABELS[link.store as Store],
        url: link.url,
        ok: read.ok,
        price: read.price,
        currency: read.currency,
        pricePerOz: read.pricePerOz,
        sizeLabel: read.size?.label ?? product.size_label ?? null,
        inStock: read.inStock,
        error: read.error,
      }));

      // Crown a "cheapest" only on a true per-oz basis. Comparing absolute
      // prices across different pack sizes would be misleading, so when no
      // store yielded a per-oz figure we leave cheapestStore null.
      const ranked = rows
        .filter((r) => r.ok && r.pricePerOz != null)
        .sort((a, b) => (a.pricePerOz! - b.pricePerOz!));

      comparisons.push({
        productId: product.id,
        name: product.name,
        brand: product.brand,
        imageUrl: product.image_url,
        sizeLabel: product.size_label,
        kosherStatus: product.kosher_status,
        kosherNote: product.kosher_note,
        rows,
        cheapestStore: ranked[0]?.store ?? null,
      });
    }

    return res.json({ comparisons });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[price-tracker] check failed:", err);
    return res.status(500).json({ error: msg });
  }
});

export default router;
