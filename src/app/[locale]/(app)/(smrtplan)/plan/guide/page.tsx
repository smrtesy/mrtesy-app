import { getTranslations } from "next-intl/server";

export default async function PlanGuidePage() {
  const t = await getTranslations("smrtPlan");
  const sections = [
    { title: t("guide.s1Title"), body: t("guide.s1Body") },
    { title: t("guide.s2Title"), body: t("guide.s2Body") },
    { title: t("guide.s3Title"), body: t("guide.s3Body") },
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">{t("guide.title")}</h1>
      <p className="leading-relaxed text-muted-foreground">{t("guide.intro")}</p>
      <div className="space-y-4">
        {sections.map((s) => (
          <div key={s.title} className="rounded-xl border bg-card p-4">
            <h2 className="text-base font-bold">{s.title}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
