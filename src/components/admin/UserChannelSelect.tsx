"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

type Channel = "stable" | "beta";

/**
 * Compact per-user feature-channels override selector, shown inline in each
 * /admin/users row. Super-admin only (the whole /admin section is gated).
 * Optimistic: flips the local value immediately, PATCHes, reverts on failure.
 * Hebrew is hardcoded (same pattern as FeaturesClient / AppStatusCard) so no
 * i18n keys are added.
 */
export function UserChannelSelect({
  userId,
  initial,
}: {
  userId: string;
  initial: Channel;
}) {
  const [value, setValue] = useState<Channel>(initial);
  const [busy, setBusy] = useState(false);

  async function set(next: Channel) {
    if (next === value || busy) return;
    const prev = value;
    setValue(next); // optimistic
    setBusy(true);
    try {
      await api(`/api/admin/users/${userId}/channel`, {
        method: "PATCH",
        body: { value: next },
        noOrg: true,
      });
    } catch (e) {
      setValue(prev); // revert
      if (!(e instanceof ApiError && e.status === 401)) {
        toast.error((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const opts: Array<{ key: Channel; label: string }> = [
    { key: "stable", label: "יציב" },
    { key: "beta", label: "בטא" },
  ];

  return (
    <div
      className="inline-flex shrink-0 overflow-hidden rounded-md border text-[10px] leading-none"
      // The row is a link; keep clicks on the toggle from navigating.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={busy}
          onClick={() => set(o.key)}
          className={`px-2 py-1 transition-colors disabled:opacity-50 ${
            value === o.key
              ? "bg-primary text-primary-foreground"
              : "bg-transparent text-muted-foreground hover:bg-accent"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
