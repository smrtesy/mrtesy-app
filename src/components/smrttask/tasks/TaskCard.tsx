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
  Folder,
  CheckSquare,
  Play,
  Trash2,
  Bell,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { translateActionLabel } from "@/lib/actionLabels";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import type { Task } from "@/types/task";

interface TaskCardProps {
  task: Task;
  locale: string;
  onSelect: (task: Task) => void;
  onComplete: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onActivate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onQuickAction: (taskId: string, action: { label: string; prompt: string }) => void;
  onDriveSearch?: (taskId: string, description: string) => void;
  /** Optional bulk-select integration. When provided, a checkbox is shown. */
  selected?: boolean;
  onToggleSelect?: (taskId: string) => void;
}

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
  onActivate,
  onDelete,
  onQuickAction,
  onDriveSearch,
  selected,
  onToggleSelect,
}: TaskCardProps) {
  const project = task.projects ?? null;
  const t = useTranslations("tasks");
  const tActions = useTranslations("tasks.actions");
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const isNew = !task.seen_at;
  const aiActions = (task.ai_actions || []).slice(0, 2);
  const source = task.source_messages ?? null;
  const checklist = task.checklist ?? [];
  const checklistTotal = checklist.length;
  const checklistDone = checklist.filter((it) => it.done).length;
  const isPendingCompletion = task.status === "pending_completion";
  const hasUnread = Boolean(task.has_unread_update);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer",
        isNew && "border-s-2 border-s-blue-400/30",
        isPendingCompletion && "border-s-4 border-s-emerald-500",
        hasUnread && !isPendingCompletion && "border-s-4 border-s-amber-500",
        selected && "ring-2 ring-primary/50"
      )}
      onClick={() => onSelect(task)}
    >
      {/* Completion / unread banner (above title for visibility) */}
      {(isPendingCompletion || hasUnread) && (
        <div
          className={cn(
            "mb-2 -mx-1 -mt-1 rounded-md px-2 py-1 text-xs flex items-start gap-2",
            isPendingCompletion ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900",
          )}
        >
          <Bell className="h-3 w-3 mt-0.5 shrink-0" />
          <span dir="auto" className="flex-1">
            {isPendingCompletion
              ? task.completion_signal_reason || t("completionBanner")
              : t("hasUnreadUpdate")}
          </span>
        </div>
      )}

      {/* Title + Priority */}
      <div className="flex items-start justify-between gap-2">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(task.id)}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 shrink-0 h-4 w-4 cursor-pointer"
            aria-label="select"
          />
        )}
        <h3 className="font-semibold text-sm md:text-base leading-tight flex-1" dir="auto">
          {title}
        </h3>
        <div className="flex items-center gap-1 shrink-0">
          <SerialBadge serial={task.serial_display} stopPropagation />
          <Badge className={cn("text-[10px]", priorityColors[task.priority])}>
            {t(`priority.${task.priority}`)}
          </Badge>
        </div>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1 text-xs md:text-sm text-muted-foreground line-clamp-1 md:line-clamp-2" dir="auto">
          {task.description}
        </p>
      )}

      {/* Due date + Contact + Source */}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        <SourceLink source={source} stopPropagation />
        {task.due_date && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(task.due_date).toLocaleDateString(locale === "he" ? "he-IL" : "en-US")}
          </span>
        )}
        {task.related_contact && (
          <span className="truncate" dir="auto">{task.related_contact}</span>
        )}
        {project && (
          <span
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border"
            style={project.color ? { borderColor: project.color, color: project.color } : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            <Folder className="h-2.5 w-2.5" />
            {locale === "he" && project.name_he ? project.name_he : project.name}
          </span>
        )}
        {checklistTotal > 0 && (
          <span className="flex items-center gap-1">
            <CheckSquare className="h-3 w-3" />
            {checklistDone}/{checklistTotal}
          </span>
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
              {translateActionLabel(action.label, tActions)}
            </Button>
          ))}
        </div>
      )}

      {/* Pending-completion: prominent approve / reopen row REPLACES the regular row */}
      {isPendingCompletion ? (
        <div className="mt-3 flex items-center gap-2 border-t pt-2">
          <Button
            variant="default"
            size="sm"
            className="h-9 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={(e) => {
              e.stopPropagation();
              onComplete(task.id);
            }}
          >
            <CheckCircle2 className="h-4 w-4" />
            {t("approveClose")}
          </Button>
          {onActivate && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onActivate(task.id);
              }}
            >
              <RotateCcw className="h-4 w-4" />
              {t("reopenToInbox")}
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              title={t("actions.delete")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
      /* Regular bottom action row */
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
              onDriveSearch?.(task.id, task.description || title);
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
          {onActivate && task.status === "inbox" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-8 md:w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
              onClick={(e) => {
                e.stopPropagation();
                onActivate(task.id);
              }}
              title={t("actions.activate")}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-8 md:w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              title={t("actions.delete")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 md:h-8 gap-1 text-green-600/40 hover:text-white hover:bg-green-600 active:bg-green-700"
          onClick={(e) => {
            e.stopPropagation();
            onComplete(task.id);
          }}
        >
          <CheckCircle2 className="h-4 w-4" />
          <span className="hidden md:inline">{t("actions.complete")}</span>
        </Button>
      </div>
      )}
    </div>
  );
}
