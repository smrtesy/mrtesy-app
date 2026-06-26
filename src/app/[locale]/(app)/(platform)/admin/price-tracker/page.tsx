"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2, ShoppingCart, Plus, Trash2, Play, ExternalLink,
  Upload, ListChecks, BadgeCheck, BadgeX, HelpCircle, Link2, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

// ── types (mirror the backend contract) ─────────────────────────────────────

type Store = "amazon" | "amazon_fresh" | "walmart" | "costco" | "costco_sameday";

const STORE_LABELS: Record<Store, string> = {
  amazon: "Amazon",
  amazon_fresh: "Amazon Fresh",
  walmart: "Walmart",
  costco: "Costco",
  costco_sameday: "Costco Same-Day",
};

interface ProductLink { id: string; store: Store; url: string }
interface Product {
  id: string;
  name: string;
  brand: string | null;
  image_url: string | null;
  size_value: number | null;
  size_unit: string | null;
  size_label: string | null;
  kosher_status: "kosher" | "not_kosher" | "unclear";
  kosher_note: string | null;
  source_url: string | null;
  source_store: Store | null;
  links: ProductLink[];
}

interface CompRow {
  store: Store;
  storeLabel: string;
  found: boolean;
  url: string | null;
  matchedTitle: string | null;
  ok: boolean;
  price: number | null;
  currency: string;
  pricePerOz: number | null;
  sizeLabel: string | null;
  inStock: boolean | null;
  isCheapest: boolean;
  differentSize: boolean;
  error: string | null;
}
interface Comparison {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  sizeLabel: string | null;
  kosherStatus: "kosher" | "not_kosher" | "unclear";
  kosherNote: string | null;
  rows: CompRow[];
  alternatives: AltRow[];
  cheapestStore: Store | null;
  searchEnabled: boolean;
  aiCost: number;
}
interface AltRow {
  store: Store; storeLabel: string; url: string; title: string;
  tier: "close" | "loose"; kosher: "kosher" | "not_kosher" | "unclear";
  price: number | null; currency: string; pricePerOz: number | null;
  sizeLabel: string | null; inStock: boolean | null; isCheapest: boolean; error: string | null;
}
interface AiCost { today: number; week: number; month: number; allTime: number; calls: number }
interface Prefs { kosher_only: boolean; substitution_level: "off" | "exact" | "close" | "loose" }

// ── small presentational helpers ────────────────────────────────────────────

function KosherBadge({ status, note }: { status: Product["kosher_status"]; note: string | null }) {
  const t = useTranslations("priceTracker");
  if (status === "kosher")
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 gap-1"><BadgeCheck className="h-3 w-3" />{t("kosher")}</Badge>;
  if (status === "not_kosher")
    return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 gap-1"><BadgeX className="h-3 w-3" />{t("notKosher")}</Badge>;
  return (
    <Badge variant="secondary" className="gap-1" title={note ?? undefined}>
      <HelpCircle className="h-3 w-3" />{t("kosherUnclear")}
    </Badge>
  );
}

function fmtMoney(n: number | null, currency = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}
function fmtPerOz(n: number | null) {
  if (n == null) return "—";
  return `$${n.toFixed(3)}`;
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function PriceTrackerPage() {
  const t = useTranslations("priceTracker");

  const [products, setProducts] = useState<Product[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);


  const [aiCost, setAiCost] = useState<AiCost | null>(null);
  const loadAiCost = useCallback(async () => {
    try {
      setAiCost(await api<AiCost>("/api/admin/price-tracker/ai-cost", { noOrg: true }));
    } catch { /* meter is non-critical */ }
  }, []);

  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const loadPrefs = useCallback(async () => {
    try { setPrefs((await api<{ prefs: Prefs }>("/api/admin/price-tracker/prefs", { noOrg: true })).prefs); }
    catch { /* non-critical */ }
  }, []);
  async function toggleKosher() {
    if (!prefs) return;
    const next = !prefs.kosher_only;
    setPrefs({ ...prefs, kosher_only: next }); // optimistic
    try { await api("/api/admin/price-tracker/prefs", { method: "PUT", noOrg: true, body: { kosher_only: next } }); }
    catch (err) { setPrefs(prefs); toast.error(err instanceof Error ? err.message : String(err)); }
  }

  const loadProducts = useCallback(async () => {
    setLoadingList(true);
    try {
      const { products } = await api<{ products: Product[] }>("/api/admin/price-tracker/products", { noOrg: true });
      setProducts(products);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { void loadProducts(); void loadAiCost(); void loadPrefs(); }, [loadProducts, loadAiCost, loadPrefs]);

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setIngesting(true);
    setError(null);
    try {
      // Accept either a product URL or a free-text product name.
      const input = url.trim();
      const isUrl = /^https?:\/\//i.test(input);
      const { product, comparison } = await api<{ product: Product; comparison: Comparison }>(
        isUrl ? "/api/admin/price-tracker/ingest" : "/api/admin/price-tracker/ingest-by-name",
        { method: "POST", noOrg: true, body: isUrl ? { url: input } : { name: input } },
      );
      setProducts((prev) => [product, ...prev.filter((p) => p.id !== product.id)]);
      // The ingest already ran the cross-store comparison — show it at once.
      if (comparison) setComparisons((prev) => [comparison, ...prev.filter((c) => c.productId !== comparison.productId)]);
      setUrl("");
      toast.success(t("added"));
      void loadAiCost();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setIngesting(false);
    }
  }

  async function handleBulk() {
    const urls = bulkText.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    setBulkRunning(true);
    try {
      const { results, products } = await api<{ results: { url: string; ok: boolean; error?: string }[]; products: Product[] }>(
        "/api/admin/price-tracker/bulk-ingest", { method: "POST", noOrg: true, body: { urls } },
      );
      setProducts(products);
      const okCount = results.filter((r) => r.ok).length;
      toast.success(t("bulkResult", { ok: okCount, total: results.length }));
      setBulkText("");
      setBulkOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkRunning(false);
    }
  }

  const [refreshing, setRefreshing] = useState<string | null>(null);
  async function handleRefresh(id: string) {
    setRefreshing(id);
    try {
      const { product, warning } = await api<{ product: Product; warning?: string }>(`/api/admin/price-tracker/products/${id}/refresh`, {
        method: "POST", noOrg: true,
      });
      setProducts((prev) => prev.map((p) => (p.id === id ? product : p)));
      if (warning) toast.warning(warning);
      else toast.success(t("refreshed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api("/api/admin/price-tracker/products/" + id, { method: "DELETE", noOrg: true });
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
      setComparisons((prev) => prev.filter((c) => c.productId !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }


  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((prev) => (prev.size === products.length ? new Set() : new Set(products.map((p) => p.id))));
  }

  async function runCheck() {
    const ids = [...selected];
    if (!ids.length) return;
    setChecking(true);
    setComparisons([]);
    setError(null);
    try {
      const { comparisons } = await api<{ comparisons: Comparison[] }>("/api/admin/price-tracker/check", {
        method: "POST", noOrg: true, body: { productIds: ids },
      });
      setComparisons(comparisons);
      void loadAiCost();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-6 w-6" />
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* kosher-only toggle — hard filter on alternatives */}
          {prefs && (
            <button
              onClick={toggleKosher}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${prefs.kosher_only ? "border-green-500 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300" : "text-muted-foreground"}`}
              title={t("kosherOnlyTip")}
            >
              <BadgeCheck className="h-3.5 w-3.5" />
              {t("kosherOnly")}: {prefs.kosher_only ? t("on") : t("off")}
            </button>
          )}
          {/* real-time AI cost meter (from token usage) */}
          {aiCost && (
            <div className="rounded-md border px-3 py-1.5 text-xs font-mono leading-tight" title={t("aiMeterTip", { calls: aiCost.calls, all: aiCost.allTime.toFixed(4) })}>
              <span className="text-muted-foreground">{t("aiToday")} </span>
              <span className="font-semibold tabular-nums">${aiCost.today.toFixed(4)}</span>
              <span className="text-muted-foreground"> · {t("aiMonth")} </span>
              <span className="font-semibold tabular-nums">${aiCost.month.toFixed(4)}</span>
            </div>
          )}
          {/* Bulk upload — collapsed by default (compact UI convention) */}
          <Button variant="outline" size="sm" onClick={() => setBulkOpen((v) => !v)}>
            <Upload className="h-3.5 w-3.5" />
            <span className="ms-1.5">{t("bulkUpload")}</span>
          </Button>
        </div>
      </div>

      {/* add single product */}
      <form onSubmit={handleIngest} className="flex gap-2">
        <Input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("urlOrNamePlaceholder")}
          className="text-sm"
          required
          disabled={ingesting}
        />
        <Button type="submit" disabled={ingesting || !url.trim()} className="shrink-0">
          {ingesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          <span className="ms-2">{ingesting ? t("adding") : t("add")}</span>
        </Button>
      </form>

      {bulkOpen && (
        <div className="rounded-md border p-3 space-y-2 bg-muted/30">
          <p className="text-xs text-muted-foreground">{t("bulkHint")}</p>
          <Textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"https://www.amazon.com/...\nhttps://www.walmart.com/..."}
            rows={5}
            className="font-mono text-xs"
            dir="ltr"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setBulkOpen(false)}>{t("cancel")}</Button>
            <Button size="sm" onClick={handleBulk} disabled={bulkRunning || !bulkText.trim()}>
              {bulkRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              <span className="ms-1.5">{bulkRunning ? t("uploading") : t("uploadList")}</span>
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* action bar */}
      {products.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Button variant="ghost" size="sm" onClick={toggleAll}>
            <ListChecks className="h-4 w-4" />
            <span className="ms-1.5">{selected.size === products.length ? t("clearSelection") : t("selectAll")}</span>
          </Button>
          <Button onClick={runCheck} disabled={checking || selected.size === 0}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            <span className="ms-2">{checking ? t("checking") : t("runComparison", { n: selected.size })}</span>
          </Button>
        </div>
      )}

      {checking && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground py-6 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("checkingMessage")}
        </div>
      )}

      {/* comparison results */}
      {comparisons.length > 0 && (
        <div className="space-y-4">
          {comparisons.map((c) => (
            <div key={c.productId} className="rounded-md border overflow-hidden">
              <div className="flex items-center gap-3 p-3 bg-muted/40 border-b">
                {c.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt="" className="h-12 w-12 rounded object-contain bg-white" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{c.name}</div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    {c.brand && <span>{c.brand}</span>}
                    {c.sizeLabel && <span dir="ltr">· {c.sizeLabel}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-muted-foreground tabular-nums" title={t("aiCostTip")}>
                    AI ${c.aiCost.toFixed(4)}
                  </span>
                  <KosherBadge status={c.kosherStatus} note={c.kosherNote} />
                </div>
              </div>
              <div className="grid grid-cols-[1fr_5rem_6rem_5rem_2rem] gap-x-2 px-3 py-1.5 text-[11px] font-medium text-muted-foreground border-b">
                <span>{t("store")}</span>
                <span className="text-end">{t("price")}</span>
                <span className="text-end">{t("perOz")}</span>
                <span className="text-end">{t("stock")}</span>
                <span></span>
              </div>
              {[...c.rows]
                .sort((a, b) => {
                  if (a.pricePerOz != null && b.pricePerOz != null) return a.pricePerOz - b.pricePerOz;
                  if (a.ok !== b.ok) return a.ok ? -1 : 1;
                  return (a.price ?? Infinity) - (b.price ?? Infinity);
                })
                .map((r) => {
                  const isCheapest = r.isCheapest;
                  return (
                    <div
                      key={r.store}
                      className={`grid grid-cols-[1fr_5rem_6rem_5rem_2rem] gap-x-2 items-center px-3 py-2 border-b last:border-0 text-sm ${
                        isCheapest ? "bg-green-50/70 dark:bg-green-950/20" : !r.found ? "opacity-60" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="truncate font-medium">{r.storeLabel}</span>
                          {isCheapest && (
                            <Badge className="bg-green-600 text-white text-[10px] px-1.5 py-0 shrink-0">{t("cheapest")}</Badge>
                          )}
                          {r.differentSize && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0 border-amber-400 text-amber-600 dark:text-amber-400">{t("differentSize")}</Badge>
                          )}
                        </div>
                        {/* the matched product on this store — pack/size may differ */}
                        {r.found && r.matchedTitle && (
                          <div className="text-[11px] text-muted-foreground truncate" dir="ltr" title={r.matchedTitle}>
                            {r.matchedTitle}{r.sizeLabel ? ` · ${r.sizeLabel}` : ""}
                          </div>
                        )}
                      </div>
                      <span className="text-end font-medium">{r.ok ? fmtMoney(r.price, r.currency) : "—"}</span>
                      <span className={`text-end font-semibold ${isCheapest ? "text-green-700 dark:text-green-400" : ""}`}>
                        {fmtPerOz(r.pricePerOz)}
                      </span>
                      <span className="text-end text-xs text-muted-foreground">
                        {r.ok ? (r.inStock === false ? t("outOfStock") : t("inStock")) : ""}
                      </span>
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="justify-self-end text-muted-foreground hover:text-foreground" title={r.error ?? r.url}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span />
                      )}
                      {!r.ok && r.error && (
                        <span className="col-span-5 text-[11px] text-amber-600 dark:text-amber-400 -mt-1">{r.error}</span>
                      )}
                    </div>
                  );
                })}
              {!c.searchEnabled && (
                <div className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400 border-t bg-amber-50/40 dark:bg-amber-950/10">
                  {t("searchDisabled")}
                </div>
              )}

              {/* ── alternatives zone: same kind of product, OTHER brands ── */}
              {c.alternatives.length > 0 && (
                <>
                  {/* clear visual divider */}
                  <div className="relative text-center pt-5 pb-1">
                    <div className="border-t-2 border-dashed border-amber-300 dark:border-amber-700/60" />
                    <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/60 text-amber-700 dark:text-amber-300 text-[11px] font-mono font-semibold px-3 py-1 rounded-full">
                      ↓ {t("altsTitle")}
                    </span>
                  </div>
                  <div className="bg-amber-50/50 dark:bg-amber-950/15">
                    {c.alternatives.map((a) => (
                      <div key={a.store + a.url} className={`grid grid-cols-[1fr_5rem_6rem_2rem] gap-x-2 items-center px-3 py-2 border-t border-amber-100 dark:border-amber-900/30 text-sm ${a.isCheapest ? "bg-amber-100/60 dark:bg-amber-900/20" : ""}`}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] font-semibold px-1.5 py-0 rounded-full bg-amber-200/70 text-amber-800 dark:bg-amber-800/40 dark:text-amber-200">{t("altTag")}</span>
                            {a.kosher === "kosher" && <span className="text-[10px] font-semibold px-1.5 py-0 rounded-full bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">{t("kosher")}</span>}
                            {a.isCheapest && <span className="text-[10px] font-semibold px-1.5 py-0 rounded-full bg-green-600 text-white">{t("cheapest")}</span>}
                          </div>
                          <div className="text-[12px] mt-0.5 truncate" dir="ltr" title={a.title}>{a.title}</div>
                          <div className="text-[11px] text-muted-foreground">{a.storeLabel}{a.sizeLabel ? ` · ${a.sizeLabel}` : ""}</div>
                        </div>
                        <span className="text-end font-medium tabular-nums">{a.price != null ? fmtMoney(a.price, a.currency) : "—"}</span>
                        <span className={`text-end font-semibold tabular-nums ${a.isCheapest ? "text-amber-700 dark:text-amber-300" : ""}`}>{fmtPerOz(a.pricePerOz)}</span>
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="justify-self-end text-muted-foreground hover:text-foreground" title={a.error ?? a.url}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* catalogue */}
      {loadingList ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("loading")}
        </div>
      ) : products.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-10 border rounded-md border-dashed">
          {t("empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {products.map((p) => {
            const isSel = selected.has(p.id);
            return (
              <div key={p.id} className={`rounded-md border p-3 flex gap-3 transition-colors ${isSel ? "border-primary bg-primary/5" : ""}`}>
                <input type="checkbox" checked={isSel} onChange={() => toggle(p.id)} className="mt-1 h-4 w-4 shrink-0 accent-primary cursor-pointer" />
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" className="h-16 w-16 rounded object-contain bg-white shrink-0" />
                ) : (
                  <div className="h-16 w-16 rounded bg-muted shrink-0 flex items-center justify-center">
                    <ShoppingCart className="h-6 w-6 text-muted-foreground/40" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium line-clamp-2" title={p.name}>{p.name}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {p.brand && <span className="text-xs text-muted-foreground">{p.brand}</span>}
                    {p.size_label && <span className="text-xs text-muted-foreground" dir="ltr">· {p.size_label}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <KosherBadge status={p.kosher_status} note={p.kosher_note} />
                    {/* stores already matched/cached for this product */}
                    {p.links.map((l) => (
                      <Badge key={l.id} variant="outline" className="text-[10px] gap-1">
                        <Link2 className="h-2.5 w-2.5" />{STORE_LABELS[l.store]}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2 shrink-0 self-start">
                  <button onClick={() => handleRefresh(p.id)} disabled={refreshing === p.id} className="text-muted-foreground hover:text-foreground" title={t("refresh")}>
                    <RefreshCw className={`h-4 w-4 ${refreshing === p.id ? "animate-spin" : ""}`} />
                  </button>
                  <button onClick={() => handleDelete(p.id)} className="text-muted-foreground hover:text-destructive" title={t("delete")}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
