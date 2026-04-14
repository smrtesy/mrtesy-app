import { getTranslations } from "next-intl/server";
import { TaskList } from "@/components/tasks/TaskList";

export default async function TasksPage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  const t = await getTranslations("tasks");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <TaskList locale={locale} />
    </div>
  );
}
