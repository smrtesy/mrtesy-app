"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Globe, Search, Copy, Check } from "lucide-react";
import { toast } from "sonner";

type DomainEntry = {
  domain: string;
  count: number;
  types: string[];
  isMain: boolean;
};

type ScanResult = {
  domains: DomainEntry[];
  mainDomain: string;
  totalRequests: number;
  totalDomains: number;
  scannedUrl: string;
};

const TYPE_COLORS: Record<string, string> = {
  document:   "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  script:     "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  stylesheet: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  image:      "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  font:       "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  xhr:        "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  fetch:      "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  media:      "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  websocket:  "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

function TypeBadge({ type }: { type: string }) {
  const cls =
    TYPE_COLORS[type] ??
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {type}
    </span>
  );
}

export default function DomainTrackerPage() {
  const t = useTranslations("domainTracker");

  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const data = await api<ScanResult>("/api/admin/domain-tracker", {
        method: "POST",
        noOrg: true,
        body: { url: url.trim() },
      });
      setResult(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function copyAll() {
    if (!result) return;
    const lines = result.domains.map((d) => d.domain).join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="h-6 w-6" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      <form onSubmit={handleScan} className="flex gap-2">
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("placeholder")}
          className="font-mono text-sm"
          required
          disabled={loading}
          dir="ltr"
        />
        <Button
          type="submit"
          disabled={loading || !url.trim()}
          className="shrink-0"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          <span className="ms-2">
            {loading ? t("scanning") : t("scan")}
          </span>
        </Button>
      </form>

      {loading && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("waitMessage")}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-lg">{result.totalDomains}</span>
              <span className="text-muted-foreground">{t("domainsFound")}</span>
              <span className="text-muted-foreground">·</span>
              <span className="font-medium">{result.totalRequests}</span>
              <span className="text-muted-foreground">{t("totalRequests")}</span>
            </div>
            <Button variant="outline" size="sm" onClick={copyAll}>
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span className="ms-1.5">{t("copyAll")}</span>
            </Button>
          </div>

          <div className="rounded-md border overflow-hidden">
            {/* header */}
            <div className="grid grid-cols-[2rem_1fr_5rem_1fr] gap-x-3 px-4 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground">
              <span>#</span>
              <span>{t("domain")}</span>
              <span className="text-center">{t("requests")}</span>
              <span>{t("types")}</span>
            </div>

            {result.domains.map((d, i) => (
              <div
                key={d.domain}
                className={`grid grid-cols-[2rem_1fr_5rem_1fr] gap-x-3 items-center px-4 py-2.5 border-b last:border-0 text-sm ${
                  d.isMain ? "bg-primary/5" : "hover:bg-muted/30"
                }`}
              >
                <span className="text-muted-foreground text-xs">{i + 1}</span>

                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate" dir="ltr">
                    {d.domain}
                  </span>
                  {d.isMain && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0 shrink-0"
                    >
                      {t("main")}
                    </Badge>
                  )}
                </div>

                <span className="text-center font-medium">{d.count}</span>

                <div className="flex flex-wrap gap-1">
                  {d.types.map((type) => (
                    <TypeBadge key={type} type={type} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
