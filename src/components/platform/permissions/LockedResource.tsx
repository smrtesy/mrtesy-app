"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * The card shown in place of a screen (or next to a disabled action) the user is
 * restricted from. Phase 1: explains it's restricted and to contact the org
 * admin. Phase 2 will add a one-click "request access" button here (the backend
 * 403 already carries the resource_key for exactly that).
 */
export function LockedResource({
  resourceKey,
  labelKey,
}: {
  resourceKey: string;
  /** Optional i18n key for the resource's own name, shown in the message. */
  labelKey?: string;
}) {
  const t = useTranslations();
  const name = labelKey ? t(labelKey) : null;

  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-6 py-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          <Lock className="h-6 w-6" />
        </div>
        <h2 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">
          {t("permissions.locked.title")}
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {name
            ? t("permissions.locked.bodyNamed", { name })
            : t("permissions.locked.body")}
        </p>
        <p className="text-xs text-neutral-400 dark:text-neutral-500" dir="ltr">
          {resourceKey}
        </p>
      </div>
    </div>
  );
}
