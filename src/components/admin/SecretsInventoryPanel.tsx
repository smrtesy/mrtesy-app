"use client";

// Inventory panel — "what exists in each service". Reads every variable NAME from
// Railway / Vercel / Supabase (never a value) and shows them side by side, with a
// search box and a badge on any name that exists in more than one service (the
// "same key in two places" case the whole tool is about). Collapsed by default per
// the compact-UI rule; opens on demand.

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api/client";

interface InventoryVar {
  name: string;
  environment?: string | null;
  group?: string | null;
  updated_at?: string | null;
}
interface ProviderInventory {
  provider: "railway" | "vercel" | "supabase";
  configured: boolean;
  hint?: string;
  error?: string;
  vars: InventoryVar[];
}
interface InventoryResponse {
  railway: ProviderInventory;
  vercel: ProviderInventory;
  supabase: ProviderInventory;
}

const PROVIDER_LABEL: Record<string, string> = {
  railway: "Railway",
  vercel: "Vercel",
  supabase: "Supabase",
};

const NY_TZ = "America/New_York";
function fmtNY(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { timeZone: NY_TZ, dateStyle: "medium" });
  } catch {
    return "";
  }
}

export function SecretsInventoryPanel() {
  const t = useTranslations("adminSecretsManaged");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<InventoryResponse>(`/api/admin/secrets/inventory`);
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) load();
  }

  // Count how many services each name appears in (configured providers only) → the
  // cross-service highlight.
  const multi = new Map<string, number>();
  if (data) {
    for (const p of [data.railway, data.vercel, data.supabase]) {
      if (!p.configured) continue;
      const seen = new Set<string>();
      for (const v of p.vars) seen.add(v.name);
      for (const name of seen) multi.set(name, (multi.get(name) ?? 0) + 1);
    }
  }

  const providers = data ? [data.railway, data.vercel, data.supabase] : [];
  const needle = q.trim().toLowerCase();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <button
            className="flex items-center gap-2 text-base font-semibold hover:text-primary"
            onClick={toggle}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Layers className="h-4 w-4" />
            {t("inventoryToggle")}
          </button>
          {open && (
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {t("refresh")}
            </Button>
          )}
        </div>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("inventorySearch")}
              className="ps-8"
            />
          </div>

          {loading && !data && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {providers.map((p) => {
              const filtered = p.vars
                .filter((v) => !needle || v.name.toLowerCase().includes(needle))
                .sort((a, b) => a.name.localeCompare(b.name));
              return (
                <div key={p.provider} className="rounded-lg border">
                  <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
                    <CardTitle className="text-sm">{PROVIDER_LABEL[p.provider]}</CardTitle>
                    {p.configured && !p.error && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("varsCount", { n: p.vars.length })}
                      </Badge>
                    )}
                  </div>

                  {!p.configured ? (
                    <p className="px-3 py-3 text-xs text-muted-foreground">
                      {p.hint || t("notConfigured")}
                    </p>
                  ) : p.error ? (
                    <p className="px-3 py-3 text-xs text-destructive flex items-start gap-1">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      {p.error}
                    </p>
                  ) : filtered.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-muted-foreground">{t("inventoryEmpty")}</p>
                  ) : (
                    <ul className="max-h-80 overflow-auto divide-y">
                      {filtered.map((v, i) => {
                        const inN = multi.get(v.name) ?? 1;
                        return (
                          <li key={`${v.name}-${v.group ?? ""}-${i}`} className="px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs break-all">{v.name}</span>
                              {inN > 1 && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] gap-0.5 shrink-0"
                                  title={t("inMultipleServices", { n: inN })}
                                >
                                  ×{inN}
                                </Badge>
                              )}
                            </div>
                            {(v.group || v.environment || v.updated_at) && (
                              <div className="text-[10px] text-muted-foreground flex gap-2 flex-wrap">
                                {v.group && <span>{v.group}</span>}
                                {v.environment && <span>· {v.environment}</span>}
                                {v.updated_at && <span>· {fmtNY(v.updated_at)}</span>}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {data && (
            <p className="text-[11px] text-muted-foreground">{t("inventoryNote")}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
