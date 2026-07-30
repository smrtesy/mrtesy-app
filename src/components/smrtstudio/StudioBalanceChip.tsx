"use client";

/**
 * smrtStudio — the fal credit chip (stage D of docs/studio-build-plan.md).
 *
 * The one always-visible money surface, kept tiny per the compact-UI rule:
 * a colored amount; click opens a small popover with month spend and the
 * top-up deep link. Money is manager information — the endpoint is
 * role-gated, a 403 renders NOTHING (a member never sees an error).
 * No FAL_ADMIN_KEY yet → a muted chip that says so, never a fake $0.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api/client";

type Billing = {
  balance: { current_balance: number; currency: string } | null;
  balance_error: string | null;
  fal_month_usd: number;
  fal_total_usd: number;
  top_up_url: string;
};

export function StudioBalanceChip() {
  const t = useTranslations("studioProjects");
  const [billing, setBilling] = useState<Billing | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<Billing>("/api/studio/billing");
        if (!cancelled) setBilling(data);
      } catch (e) {
        // 403 = not a manager: the chip is simply absent. Anything else is
        // also non-fatal — money display must never break the screen.
        if (!cancelled) setHidden(true);
        void e;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (hidden || !billing) return null;

  const bal = billing.balance?.current_balance ?? null;
  const tone =
    bal == null ? "text-muted-foreground border-muted"
    : bal <= 2 ? "text-red-600 border-red-300"
    : bal <= 10 ? "text-amber-600 border-amber-300"
    : "text-emerald-700 border-emerald-300";

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        onClick={() => setOpen((v) => !v)}
        className={`h-7 rounded-full border px-2.5 text-xs font-medium ${tone}`}
        title={bal == null ? t("billingNotConfigured") : t("billingChipTitle")}
      >
        {bal == null ? "$—" : `$${bal.toFixed(2)}`}
      </button>
      {open && (
        <div className="absolute end-0 z-20 mt-1 w-64 rounded-lg border bg-popover p-3 text-xs shadow-md space-y-2">
          <p className="flex justify-between">
            <span>{t("billingBalance")}</span>
            <span className="font-medium">{bal == null ? t("billingNotConfigured") : `$${bal.toFixed(2)}`}</span>
          </p>
          <p className="flex justify-between">
            <span>{t("billingMonth")}</span>
            <span className="font-medium">${billing.fal_month_usd.toFixed(2)}</span>
          </p>
          <p className="flex justify-between">
            <span>{t("billingTotal")}</span>
            <span className="font-medium">${billing.fal_total_usd.toFixed(2)}</span>
          </p>
          <a
            href={billing.top_up_url}
            target="_blank"
            rel="noreferrer"
            className="block text-primary underline"
          >
            {t("billingTopUp")}
          </a>
        </div>
      )}
    </div>
  );
}
