"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api/client";

export function BudgetIndicator() {
  const t = useTranslations("smrtVoice.budget");
  const [data, setData] = useState<{ used: number; budget: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { used, budget } = await api<{ used: number; budget: number }>(
          "/api/voice/budget",
        );
        if (mounted) setData({ used, budget });
      } catch {
        // silently ignore — header widget shouldn't error out
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!data) return null;
  const pct = data.budget > 0 ? Math.min(100, (data.used / data.budget) * 100) : 0;

  return (
    <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t("label")}</span>
      <span className="font-medium">
        ${data.used.toFixed(2)} / ${data.budget.toFixed(0)}
      </span>
      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
