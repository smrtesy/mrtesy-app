"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, ExternalLink } from "lucide-react";

/**
 * Lightweight wrapper — actual platform admin lives at /admin with its own
 * AdminNav. This panel just funnels the super-admin there so /settings stays
 * canonical for "everything in one place" while preserving the deep admin UX.
 */
export function PlatformTabPanel() {
  const t = useTranslations("settingsTabs");
  const { locale } = useParams() as { locale: string };
  return (
    <Card>
      <CardContent className="p-6">
        <Link
          href={`/${locale}/admin`}
          className="flex items-center justify-between gap-3 text-sm font-medium text-primary hover:underline"
        >
          <span className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t("openPlatformAdmin")}
          </span>
          <ExternalLink className="h-4 w-4" />
        </Link>
        <p className="text-xs text-muted-foreground mt-3">{t("platformDescription")}</p>
      </CardContent>
    </Card>
  );
}
