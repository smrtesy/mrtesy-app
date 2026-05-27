"use client";

import { useTranslations, useLocale } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, CheckSquare, BookOpen } from "lucide-react";
import { formatDateOnly } from "@/lib/date";

type ItemType = "suggestion" | "task" | "info";

export interface InfoCenterItem {
  id: string;
  type: ItemType;
  title: string;
  body?: string | null;
  priority?: string | null;
  status?: string | null;
  due_date?: string | null;
}

interface Props {
  suggestions: InfoCenterItem[];
  tasks: InfoCenterItem[];
  infoItems: InfoCenterItem[];
}

const TYPE_ICON = {
  suggestion: Lightbulb,
  task: CheckSquare,
  info: BookOpen,
} as const;

const TYPE_COLOR = {
  suggestion: "text-amber-500",
  task: "text-blue-500",
  info: "text-green-600",
} as const;

export function ProjectInfoCenter({ suggestions, tasks, infoItems }: Props) {
  const t = useTranslations("projectDetail");
  const locale = useLocale();

  const sections = [
    { type: "suggestion" as ItemType, labelKey: "sectionSuggestions", items: suggestions },
    { type: "task" as ItemType,       labelKey: "sectionTasks",        items: tasks       },
    { type: "info" as ItemType,       labelKey: "sectionInfoItems",    items: infoItems   },
  ].filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("infoCenterEmpty")}</p>;
  }

  return (
    <div className="flex gap-4">
      {/* Sticky left TOC — desktop only */}
      <aside className="hidden md:block w-44 shrink-0 self-start sticky top-4">
        <nav className="space-y-4 text-sm" aria-label={t("infoCenter")}>
          {sections.map(({ type, labelKey, items }) => {
            const Icon = TYPE_ICON[type];
            const colorClass = TYPE_COLOR[type];
            return (
              <div key={type}>
                <a
                  href={`#section-${type}`}
                  className={`flex items-center gap-1.5 font-semibold hover:opacity-75 transition-opacity ${colorClass}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t(labelKey as Parameters<typeof t>[0])}</span>
                  <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
                </a>
                <ul className="mt-1 space-y-0.5 ps-5">
                  {items.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#item-${item.id}`}
                        className="block text-xs text-muted-foreground hover:text-foreground truncate"
                        title={item.title}
                        dir="auto"
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Content document */}
      <div className="flex-1 min-w-0 space-y-8">
        {/* Mobile TOC chips — horizontal scroll row, inside content flow */}
        <div className="md:hidden flex gap-2 overflow-x-auto pb-1">
          {sections.map(({ type, labelKey, items }) => {
            const Icon = TYPE_ICON[type];
            return (
              <a
                key={type}
                href={`#section-${type}`}
                className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs whitespace-nowrap hover:bg-muted transition-colors"
              >
                <Icon className="h-3 w-3 shrink-0" />
                {t(labelKey as Parameters<typeof t>[0])} ({items.length})
              </a>
            );
          })}
        </div>
        {sections.map(({ type, labelKey, items }) => {
          const Icon = TYPE_ICON[type];
          const colorClass = TYPE_COLOR[type];
          return (
            <section
              key={type}
              id={`section-${type}`}
              className="scroll-mt-16"
              aria-label={t(labelKey as Parameters<typeof t>[0])}
            >
              <h3 className={`flex items-center gap-2 text-sm font-semibold mb-3 ${colorClass}`}>
                <Icon className="h-4 w-4 shrink-0" />
                {t(labelKey as Parameters<typeof t>[0])}
                <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
              </h3>

              <div className="space-y-2">
                {items.map((item) => (
                  <article
                    key={item.id}
                    id={`item-${item.id}`}
                    className="rounded-lg border bg-card px-3 py-2.5 scroll-mt-16"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug flex-1 min-w-0" dir="auto">
                        {item.title}
                      </p>
                      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                        {item.priority && (
                          <Badge variant="outline" className="text-[10px]">
                            {item.priority}
                          </Badge>
                        )}
                        {item.status && item.type !== "info" && (
                          <Badge variant="secondary" className="text-[10px]">
                            {item.status}
                          </Badge>
                        )}
                        {item.due_date && (
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {formatDateOnly(item.due_date, locale)}
                          </span>
                        )}
                      </div>
                    </div>
                    {item.body && item.body !== item.title && (
                      <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed" dir="auto">
                        {item.body}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
