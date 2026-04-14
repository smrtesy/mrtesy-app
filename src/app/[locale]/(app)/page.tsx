"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { TaskList } from "@/components/tasks/TaskList";

export default function TasksPage() {
  const t = useTranslations("tasks");
  const { locale } = useParams();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <TaskList locale={locale as string} />
    </div>
  );
}
