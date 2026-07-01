import { getTranslations } from "next-intl/server";
import { VoiceNav } from "@/components/smrtvoice/VoiceNav";
import { CharactersList } from "@/components/smrtvoice/CharactersList";

export default async function CharactersPage() {
  const t = await getTranslations("smrtVoice");
  return (
    <div className="p-6 space-y-6">
      <VoiceNav />
      <div>
        <h1 className="text-2xl font-bold">{t("characters.title")}</h1>
        <p className="text-muted-foreground">{t("characters.subtitle")}</p>
      </div>
      <CharactersList />
    </div>
  );
}
