import { getTranslations } from "next-intl/server";

export default async function ReachGuidePage() {
  const t = await getTranslations("smrtReach");
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">{t("guide.title")}</h1>
      <p className="text-muted-foreground leading-relaxed">{t("guide.intro")}</p>
      <ul className="list-disc space-y-2 ps-6 text-muted-foreground leading-relaxed">
        <li>{t("guide.point1")}</li>
        <li>{t("guide.point2")}</li>
        <li>{t("guide.point3")}</li>
      </ul>
    </div>
  );
}
