import { getTranslations } from "next-intl/server";

export default async function SmrtBotGuidePage() {
  const t = await getTranslations("smrtBot");
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">{t("guide.title")}</h1>
      <p className="text-muted-foreground leading-relaxed">{t("guide.intro")}</p>
    </div>
  );
}
