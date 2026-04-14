"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Zap,
  MessageCircle,
  FolderSearch,
  Clock,
  CheckCircle2,
  Mail,
  FolderOpen,
  Calendar,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

interface TaskCardProps {
  task: Task;
  locale: string;
  onSelect: (task: Task) => void;
  onComplete: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onQuickAction: (taskId: string, action: { label: string; prompt: string }) => void;
}

const sourceIcons: Record<string, typeof Mail> = {
  gmail: Mail,
  whatsapp: MessageCircle,
  google_drive: FolderOpen,
  google_calendar: Calendar,
};

const priorityColors: Record<string, string> = {
  urgent: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-blue-500 text-white",
  low: "bg-gray-400 text-white",
};

export function TaskCard({
  task,
  locale,
  onSelect,
  onComplete,
  onSnooze,
  onQuickAction,
}: TaskCardProps) {
  const t = useTranslations("tasks");
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const isNew = !task.seen_at;
  const aiActions = (task.ai_actions || []).slice(0, 2);
  const source = (task as any).source_messages as { source_type?: string; source_url?: string } | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const SourceIcon = sourceIcons[source?.source_type || ""] || null;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer",
        isNew && "border-s-4 border-s-blue-500"
      )}
      onClick={() => onSelect(task)}
    >
      {/* Title + Priority */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-sm md:text-base leading-tight flex-1">
          {title}
        </h3>
        <Badge className={cn("text-[10px] shrink-0", priorityColors[task.priority])}>
          {t(`priority.${task.priority}`)}
        </Badge>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1 text-xs md:text-sm text-muted-foreground line-clamp-1 md:line-clamp-2">
          {task.description}
        </p>
      )}

      {/* Due date + Contact + Source */}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {SourceIcon && (
          source?.source_url ? (
            <a
              href={source.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <SourceIcon className="h-3 w-3" />
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : (
            <SourceIcon className="h-3 w-3" />
          )
        )}
        {task.due_date && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(task.due_date).toLocaleDateString(locale === "he" ? "he-IL" : "en-US")}
          </span>
        )}
        {task.related_contact && (
          <span className="truncate">{task.related_contact}</span>
        )}
      </div>

      {/* AI Action Buttons */}
      {aiActions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {aiActions.map((action, i) => (
            <Button
              key={i}
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAction(task.id, action);
              }}
            >
              <Zap className="h-3 w-3" />
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {/* Bottom action row */}
      <div className="mt-3 flex items-center justify-between border-t pt-2">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-8 md:w-8"
            onClick={(e) => {
              e.stopPropagation();
              // Open claude.ai/new with context
              window.open(
                `https://claude.ai/new?q=${encodeURIComponent(task.description || title)}`,
                "_blank"
              );
            }}
            title={t("actions.aiChat")}
          >
            <MessageCircle className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-8 md:w-8"
            onClick={(e) => {
              e.stopPropagation();
              // Drive search — will be implemented in Step 9
            }}
            title={t("actions.searchDocs")}
          >
            <FolderSearch className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 md:h-8 md:w-8"
            onClick={(e) => {
              e.stopPropagation();
              onSnooze(task.id);
            }}
            title={t("actions.snooze")}
          >
            <Clock className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 md:h-8 gap-1 text-green-600 hover:text-green-700 hover:bg-green-50"
          onClick={(e) => {
            e.stopPropagation();
            onComplete(task.id);
          }}
        >
          <CheckCircle2 className="h-4 w-4" />
          <span className="hidden md:inline">{t("actions.complete")}</span>
        </Button>
      </div>
    </div>
  );
}
