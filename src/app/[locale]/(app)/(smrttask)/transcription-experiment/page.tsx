export const dynamic = "force-dynamic";
import { getTranslations } from "next-intl/server";
import { TranscriptionExperimentClient } from "./TranscriptionExperimentClient";

export default async function TranscriptionExperimentPage() {
  const t = await getTranslations("transcriptionExperiment");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>
      <TranscriptionExperimentClient />
    </div>
  );
}
