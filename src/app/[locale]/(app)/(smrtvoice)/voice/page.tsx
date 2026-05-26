export const dynamic = "force-dynamic";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProjectsList } from "@/components/smrtvoice/ProjectsList";
import { BudgetIndicator } from "@/components/smrtvoice/BudgetIndicator";

export default async function VoiceDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("smrtVoice");

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("projects.title")}</h1>
          <p className="text-muted-foreground">{t("projects.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <BudgetIndicator />
          <Link href={`/${locale}/voice/projects/new`}>
            <Button>
              <Plus className="w-4 h-4 me-2" />
              {t("projects.new")}
            </Button>
          </Link>
        </div>
      </div>
      <ProjectsList />
    </div>
  );
}
