"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MessageCircle,
  FolderSearch,
  Clock,
  CheckCircle2,
  Check,
  Folder,
  CheckSquare,
  Sunrise,
  Sunset,
  Trash2,
  Bell,
  RotateCcw,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { extractTaskLinks } from "@/lib/smrttask/links";
import { LinkifiedText } from "@/components/smrttask/common/LinkifiedText";
import { LinkActions } from "@/components/smrttask/common/LinkActions";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import type { Task } from "@/types/task";

interface TaskCardProps {
  task: Task;
  locale: string;
  onSelect: (task: Task) => void;
  onComplete: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onToggleToday?: (taskId: string) => void;
  onActivate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  /** No longer rendered on the card (AI ⚡ buttons hidden for now); kept so
   *  callers can stay unchanged and for easy restoration. */
  onQuickAction?: (taskId: string, action: { label: string; prompt: string }) => void;
  onDriveSearch?: (taskId: string, description: string) => void;
  /** When provided, the priority badge becomes a quick-edit dropdown. */
  onPriorityChange?: (taskId: string, priority: string) => void;
  /** Optional bulk-select integration. When provided, a checkbox is shown. */
  selected?: boolean;
  onToggleSelect?: (taskId: string) => void;
  /** Optional extra action buttons rendered at the bottom of the card. */
  extraActions?: ReactNode;
}

// דחיפות לפי הפלטה הסמנטית: דחוף=אדום, גבוה=כתום, בינוני/נמוך=אפור ניטרלי
// (הצבע בולט רק כשדחוף).
const priorityColors: Record<string, string> = {
  urgent: "bg-status-late text-white",
  high: "bg-status-warn text-white",
  medium: "bg-muted-foreground text-white",
  low: "bg-muted-foreground/40 text-white",
};

/** Small color dot matching each priority, shown in the quick-edit menu. */
const priorityDotColors: Record<string, string> = {
  urgent: "bg-status-late",
  high: "bg-status-warn",
  medium: "bg-muted-foreground",
  low: "bg-muted-foreground/40",
};

const PRIORITY_ORDER = ["urgent", "high", "medium", "low"] as const;

export function TaskCard({
  task,
  locale,
  onSelect,
  onComplete,
  onSnooze,
  onToggleToday,
  onActivate,
  onDelete,
  onDriveSearch,
  onPriorityChange,
  selected,
  onToggleSelect,
  extraActions,
}: TaskCardProps) {
  const project = task.projects ?? null;
  const t = useTranslations("tasks");
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const isNew = !task.seen_at;
  const links = extractTaskLinks(task);
  const source = task.source_messages ?? null;
  const checklist = task.checklist ?? [];
  const checklistTotal = checklist.length;
  const checklistDone = checklist.filter((it) => it.done).length;
  const isPendingCompletion = task.status === "pending_completion";
  const hasUnread = Boolean(task.has_unread_update);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer overflow-hidden",
        isNew && "border-s-2 border-s-primary/30",
        isPendingCompletion && "border-s-4 border-s-status-ok",
        selected && "ring-2 ring-primary/50"
      )}
      onClick={() => onSelect(task)}
    >
      {/* Completion / unread banner (above title for visibility) */}
      {(isPendingCompletion || hasUnread) && (
        <div
          className={cn(
            "mb-2 -mx-1 -mt-1 rounded-md px-2 py-1 text-xs flex items-start gap-2",
            isPendingCompletion ? "bg-status-ok-bg text-status-ok" : "bg-status-warn-bg text-status-warn",
          )}
        >
          <Bell className="h-3 w-3 mt-0.5 shrink-0" />
          <span dir={locale === "he" ? "rtl" : "ltr"} className="flex-1">
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
        <h3 className="font-medium text-sm md:text-base leading-tight flex-1 min-w-0 break-words" dir={locale === "he" ? "rtl" : "ltr"}>
          {title}
        </h3>
        <div className="flex items-center gap-1 shrink-0">
          {task.suggested_duplicate_of && (
            <Badge
              variant="outline"
              className="text-[10px] gap-0.5 border-status-warn bg-status-warn-bg text-status-warn"
              title={t("duplicateSuggestionBadgeTitle")}
            >
              <Copy className="h-3 w-3" />
              {t("duplicateSuggestionBadge")}
            </Badge>
          )}
          <SerialBadge serial={task.serial_display} stopPropagation />
          {onPriorityChange ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button type="button" title={t("changePriority")} aria-label={t("changePriority")}>
                  <Badge className={cn("text-[10px] cursor-pointer", priorityColors[task.priority])}>
                    {t(`priority.${task.priority}`)}
                  </Badge>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onClick={(e) => e.stopPropagation()}
              >
                {PRIORITY_ORDER.map((p) => (
                  <DropdownMenuItem
                    key={p}
                    onSelect={() => {
                      if (p !== task.priority) onPriorityChange(task.id, p);
                    }}
                    className="gap-2"
                  >
                    <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", priorityDotColors[p])} />
                    <span className="flex-1">{t(`priority.${p}`)}</span>
                    {p === task.priority && <Check className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Badge className={cn("text-[10px]", priorityColors[task.priority])}>
              {t(`priority.${task.priority}`)}
            </Badge>
          )}
        </div>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1 text-xs md:text-sm text-muted-foreground line-clamp-1 md:line-clamp-2" dir={locale === "he" ? "rtl" : "ltr"}>
          <LinkifiedText>{task.description}</LinkifiedText>
        </p>
      )}

      {/* Due date + Contact + Source */}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        <SourceLink source={source} stopPropagation />
        {task.due_date && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDateOnly(task.due_date, locale)}
          </span>
        )}
        {task.related_contact && (
          <span className="truncate" dir={locale === "he" ? "rtl" : "ltr"}>{task.related_contact}</span>
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

      {/* Actionable links pulled from the task (Zoom/Meet/doc/…) so the user
          can act straight from the card. AI suggestion buttons are hidden for
          now (until they're genuinely useful) — see git history to restore. */}
      <LinkActions links={links} />


      {/* Pending-completion: prominent approve / reopen row REPLACES the regular row */}
      {isPendingCompletion ? (
        <div className="mt-3 flex items-center gap-2 border-t pt-2">
          <Button
            variant="default"
            size="sm"
            className="h-9 gap-1 bg-status-ok hover:bg-status-ok/90 text-white"
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
            <IconButton
              label={t("actions.delete")}
              color="red"
              className="ms-auto"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      ) : (
      /* Regular bottom action row */
      <div className="mt-3 flex items-center justify-between border-t pt-2">
        <div className="flex gap-1">
          <IconButton
            label={t("actions.aiChat")}
            color="blue"
            onClick={(e) => {
              e.stopPropagation();
              // Open claude.ai/new with context
              window.open(
                `https://claude.ai/new?q=${encodeURIComponent(task.description || title)}`,
                "_blank"
              );
            }}
          >
            <MessageCircle />
          </IconButton>
          <IconButton
            label={t("actions.searchDocs")}
            color="green"
            onClick={(e) => {
              e.stopPropagation();
              onDriveSearch?.(task.id, task.description || title);
            }}
          >
            <FolderSearch />
          </IconButton>
          <IconButton
            label={t("actions.snooze")}
            color="amber"
            onClick={(e) => {
              e.stopPropagation();
              onSnooze(task.id);
            }}
          >
            <Clock />
          </IconButton>
          {onToggleToday && (
            task.today_position != null ? (
              <IconButton
                label={t("actions.removeFromToday")}
                color="amber"
                onClick={(e) => { e.stopPropagation(); onToggleToday(task.id); }}
              >
                <Sunset />
              </IconButton>
            ) : (
              <IconButton
                label={t("actions.addToToday")}
                color="amber"
                onClick={(e) => { e.stopPropagation(); onToggleToday(task.id); }}
              >
                <Sunrise />
              </IconButton>
            )
          )}
          {onDelete && (
            <IconButton
              label={t("actions.delete")}
              color="red"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 md:h-8 gap-1 text-status-ok/40 hover:text-white hover:bg-status-ok active:bg-status-ok/90"
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
      {extraActions && (
        <div className="px-4 pb-2 border-t border-border/40 pt-2">
          {extraActions}
        </div>
      )}
    </div>
  );
}
