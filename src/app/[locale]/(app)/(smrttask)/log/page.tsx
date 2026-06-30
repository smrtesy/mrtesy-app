export const dynamic = "force-dynamic";
import { getTranslations } from "next-intl/server";
import { LogPageClient } from "./LogPageClient";

export default async function LogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("log");

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 text-start">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <span className="text-xs text-muted-foreground">{t("window48h")}</span>
      </div>
      <LogPageClient locale={locale} />
    </div>
  );
}
