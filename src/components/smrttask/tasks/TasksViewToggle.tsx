"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ListTodo, CalendarDays } from "lucide-react";

export type TaskView = "list" | "calendar";

interface Props {
  value: TaskView;
  onChange: (view: TaskView) => void;
}

/**
 * Compact pill-style toggle between the two views of the tasks page.
 * Positioned on the LEFT in RTL (= the trailing edge of the row that
 * holds the page header), separate from the filter tabs that live inside
 * the list view.
 */
export function TasksViewToggle({ value, onChange }: Props) {
  const t = useTranslations("tasks.view");

  return (
    <div className="inline-flex rounded-md border bg-muted/50 p-0.5">
      <button
        type="button"
        onClick={() => onChange("list")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors",
          value === "list"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "list"}
      >
        <ListTodo className="h-3.5 w-3.5" />
        {t("list")}
      </button>
      <button
        type="button"
        onClick={() => onChange("calendar")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors",
          value === "calendar"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "calendar"}
      >
        <CalendarDays className="h-3.5 w-3.5" />
        {t("calendar")}
      </button>
    </div>
  );
}
