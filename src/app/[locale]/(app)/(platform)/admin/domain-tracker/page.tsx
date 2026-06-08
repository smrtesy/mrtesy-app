"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Globe, Search, Copy, Check, ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { toast } from "sonner";

type LoadPhase = "blocking" | "functional" | "optional";

type DomainEntry = {
  domain: string;
  count: number;
  types: string[];
  isMain: boolean;
  loadPhase: LoadPhase;
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

const PHASE_CONFIG: Record<LoadPhase, {
  icon: React.ReactNode;
  label: string;
  rowCls: string;
  badgeCls: string;
  tooltip: string;
}> = {
  blocking: {
    icon: <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />,
    label: "חוסם",
    rowCls: "bg-red-50/60 dark:bg-red-950/20",
    badgeCls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    tooltip: "נטען לפני DOMContentLoaded — אם חסום, הדף לא ייטען",
  },
  functional: {
    icon: <Shield className="h-4 w-4 text-yellow-500 shrink-0" />,
    label: "פונקציונלי",
    rowCls: "bg-yellow-50/40 dark:bg-yellow-950/10",
    badgeCls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
    tooltip: "נטען לפני load — חסימה עלולה לשבור פונקציות",
  },
  optional: {
    icon: <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />,
    label: "אופציונלי",
    rowCls: "",
    badgeCls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    tooltip: "נטען אחרי load — אנליטיקה, lazy loading — בטוח לחסום",
  },
};

function TypeBadge({ type }: { type: string }) {
  const cls =
    TYPE_COLORS[type] ??
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {type}
    </span>
  );
}

function PhaseBadge({ phase }: { phase: LoadPhase }) {
  const cfg = PHASE_CONFIG[phase];
  return (
    <span
      title={cfg.tooltip}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium cursor-help ${cfg.badgeCls}`}
    >
      {cfg.icon}
      {cfg.label}
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

  function copyBlocking() {
    if (!result) return;
    const lines = result.domains
      .filter((d) => d.loadPhase === "blocking")
      .map((d) => d.domain)
      .join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      toast.success(t("copied"));
    });
  }

  function copyEssential() {
    if (!result) return;
    const lines = result.domains
      .filter((d) => d.loadPhase === "blocking" || d.loadPhase === "functional")
      .map((d) => d.domain)
      .join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      toast.success(t("copied"));
    });
  }

  const blockingCount = result?.domains.filter((d) => d.loadPhase === "blocking").length ?? 0;
  const functionalCount = result?.domains.filter((d) => d.loadPhase === "functional").length ?? 0;
  const optionalCount = result?.domains.filter((d) => d.loadPhase === "optional").length ?? 0;

  return (
    <div className="space-y-6 max-w-5xl">
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
        <Button type="submit" disabled={loading || !url.trim()} className="shrink-0">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ms-2">{loading ? t("scanning") : t("scan")}</span>
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
          {/* Summary stats */}
          <div className="flex flex-wrap gap-3 text-sm">
            <div className="flex items-center gap-1.5 rounded-md border px-3 py-1.5">
              <ShieldAlert className="h-4 w-4 text-red-500" />
              <span className="font-semibold">{blockingCount}</span>
              <span className="text-muted-foreground">חוסמים — חייבים להיות מאושרים</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border px-3 py-1.5">
              <Shield className="h-4 w-4 text-yellow-500" />
              <span className="font-semibold">{functionalCount}</span>
              <span className="text-muted-foreground">פונקציונליים — מומלץ לאשר</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border px-3 py-1.5">
              <ShieldCheck className="h-4 w-4 text-green-500" />
              <span className="font-semibold">{optionalCount}</span>
              <span className="text-muted-foreground">אופציונליים — בטוח לחסום</span>
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-xs text-muted-foreground">
              סה&quot;כ {result.totalDomains} דומיינים · {result.totalRequests} בקשות
            </p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={copyBlocking}>
                <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                <span className="ms-1.5">העתק חוסמים בלבד</span>
              </Button>
              <Button variant="outline" size="sm" onClick={copyEssential}>
                <Shield className="h-3.5 w-3.5 text-yellow-500" />
                <span className="ms-1.5">העתק חוסמים + פונקציונליים</span>
              </Button>
              <Button variant="outline" size="sm" onClick={copyAll}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span className="ms-1.5">{t("copyAll")}</span>
              </Button>
            </div>
          </div>

          <div className="rounded-md border overflow-hidden">
            {/* header */}
            <div className="grid grid-cols-[2rem_1fr_4rem_1fr_7rem] gap-x-3 px-4 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground">
              <span>#</span>
              <span>{t("domain")}</span>
              <span className="text-center">{t("requests")}</span>
              <span>{t("types")}</span>
              <span>חסימה</span>
            </div>

            {result.domains.map((d, i) => {
              const phase = PHASE_CONFIG[d.loadPhase];
              return (
                <div
                  key={d.domain}
                  className={`grid grid-cols-[2rem_1fr_4rem_1fr_7rem] gap-x-3 items-center px-4 py-2.5 border-b last:border-0 text-sm ${
                    d.isMain ? "bg-primary/5" : phase.rowCls || "hover:bg-muted/30"
                  }`}
                >
                  <span className="text-muted-foreground text-xs">{i + 1}</span>

                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono truncate" dir="ltr">{d.domain}</span>
                    {d.isMain && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
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

                  <div>
                    <PhaseBadge phase={d.loadPhase} />
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground">
            <ShieldAlert className="inline h-3 w-3 text-red-500 me-1" />
            <strong>חוסם</strong> = נטען לפני DOMContentLoaded עם script/stylesheet — חסימה תמנע טעינת הדף. &nbsp;
            <Shield className="inline h-3 w-3 text-yellow-500 me-1" />
            <strong>פונקציונלי</strong> = נטען לפני load — חסימה עלולה לשבור פונקציות. &nbsp;
            <ShieldCheck className="inline h-3 w-3 text-green-500 me-1" />
            <strong>אופציונלי</strong> = אנליטיקה ו-lazy loading בלבד.
          </p>
        </div>
      )}
    </div>
  );
}
