export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { TasksPageClient } from "@/components/tasks/TasksPageClient";

export default async function TasksPage() {
  // Server-side work forces manifest generation
  const t = await getTranslations("tasks");
  return <TasksPageClient title={t("title")} />;
}
