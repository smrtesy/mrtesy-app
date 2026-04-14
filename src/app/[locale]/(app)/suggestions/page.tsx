import { getTranslations } from "next-intl/server";
import { SuggestionTabs } from "@/components/suggestions/SuggestionTabs";

export default async function SuggestionsPage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  const t = await getTranslations("suggestions");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <SuggestionTabs locale={locale} />
    </div>
  );
}
