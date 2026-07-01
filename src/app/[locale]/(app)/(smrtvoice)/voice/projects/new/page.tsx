import { getTranslations } from "next-intl/server";
import { CreateProjectForm } from "@/components/smrtvoice/CreateProjectForm";

export default async function NewProjectPage() {
  const t = await getTranslations("smrtVoice.folders");
  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">{t("new")}</h1>
      <CreateProjectForm />
    </div>
  );
}
