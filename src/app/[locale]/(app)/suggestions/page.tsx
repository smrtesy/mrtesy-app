import { getTranslations } from "next-intl/server";

export default async function SuggestionsPage() {
  const t = await getTranslations("suggestions");
  return (
    <div>
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {/* SuggestionTabs will be added in Step 9 */}
    </div>
  );
}
