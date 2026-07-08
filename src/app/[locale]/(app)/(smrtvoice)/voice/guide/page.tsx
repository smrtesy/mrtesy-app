import { getTranslations } from "next-intl/server";

export default async function GuidePage() {
  const t = await getTranslations("smrtVoice.guide");
  const steps = [1, 2, 3, 4, 5, 6] as const;
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground leading-relaxed">{t("intro")}</p>
      </div>

      <ol className="space-y-4">
        {steps.map((n) => (
          <li key={n} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {n}
            </span>
            <div className="space-y-1">
              <h2 className="font-semibold">{t(`s${n}Title`)}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{t(`s${n}Body`)}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="rounded-md border p-4 space-y-1">
        <h2 className="font-semibold">{t("voicesTitle")}</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{t("voicesBody")}</p>
      </div>
    </div>
  );
}
