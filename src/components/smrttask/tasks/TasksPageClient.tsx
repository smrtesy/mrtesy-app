"use client";

import { useParams } from "next/navigation";
import { TaskList } from "./TaskList";

export function TasksPageClient({ title }: { title: string }) {
  const { locale } = useParams();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{title}</h1>
      <TaskList locale={locale as string} />
    </div>
  );
}
