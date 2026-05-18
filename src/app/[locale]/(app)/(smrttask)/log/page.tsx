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
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>
      <LogPageClient locale={locale} />
    </div>
  );
}
