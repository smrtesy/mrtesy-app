"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api/client";
import { formatDateOnly } from "@/lib/date";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { TaskDetail } from "@/components/smrttask/tasks/TaskDetail";
import type { Task } from "@/types/task";

// Rich select so result cards (and the TaskDetail sheet they open) can render
// the source badge and the linked-project chip.
const SELECT_CLAUSE =
  "*, source_messages(id, source_type, source_url, serial_display), projects(id, name, name_he, color, parent_id)";

interface CombinedSearchProps {
  locale: string;
  /** Fired after a mutation inside a result's detail sheet so the host page
   *  can refresh its own list/counters. */
  onUpdate?: () => void;
  /** The page's normal content, shown whenever no search is active. */
  children: React.ReactNode;
}

interface Buckets {
  suggestions: Task[];
  tasks: Task[];
}

// Sanitize input for PostgREST filter expressions — strip characters that
// could manipulate the filter grammar.
function sanitizeFilter(value: string): string {
  return value.replace(/[%(),.*\\]/g, "").trim();
}

// A row is a "suggestion" when it's an unverified inbox item that came from an
// auto-detected source (Gmail/WhatsApp/…). Everything else is a "task".
function isSuggestion(t: Task): boolean {
  return t.status === "inbox" && t.manually_verified === false && t.source_message_id != null;
}

function splitBuckets(rows: Task[]): Buckets {
  const suggestions: Task[] = [];
  const tasks: Task[] = [];
  for (const r of rows) (isSuggestion(r) ? suggestions : tasks).push(r);
  return { suggestions, tasks };
}

/**
 * Unified search shown on both the tasks and suggestions pages. A single query
 * scans every task the user owns (optionally including the archive) and splits
 * the matches into two groups — suggestions and tasks — rendered with a
 * divider between them. Result cards are compact; tapping one opens the full
 * TaskDetail sheet where every action lives.
 *
 * `results === null` means there is no active search (input empty / below the
 * 2-char minimum) — the host page's normal content (children) is shown
 * instead. An empty `{ suggestions: [], tasks: [] }` means a search ran with
 * no matches, so we show the "no results" state rather than the full page.
 */
export function CombinedSearch({ locale, onUpdate, children }: CombinedSearchProps) {
  const t = useTranslations("tasks.search");
  const tTasks = useTranslations("tasks");
  const supabase = createClient();
  const [query, setQuery] = useState("");
  const [includeArchive, setIncludeArchive] = useState(false);
  const [results, setResults] = useState<Buckets | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Last value handed to the search, so a mutation in the detail sheet can
  // re-run the same query to refresh the result groups.
  const lastValueRef = useRef("");

  function handleChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Clearing the box (or dropping below the minimum) restores the full page
    // immediately — there's nothing to debounce.
    if (sanitizeFilter(value).length < 2) {
      lastValueRef.current = "";
      setResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value), 300);
  }

  // Re-run whenever the archive toggle flips while a query is active.
  function handleArchiveToggle(next: boolean) {
    setIncludeArchive(next);
    if (lastValueRef.current) runSearch(lastValueRef.current, next);
  }

  async function runSearch(value: string, archive = includeArchive) {
    const sanitized = sanitizeFilter(value);
    if (sanitized.length < 2) {
      lastValueRef.current = "";
      setResults(null);
      return;
    }
    lastValueRef.current = value;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const baseQuery = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("tasks")
        .select(SELECT_CLAUSE)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(60);
      if (!archive) q = q.neq("status", "archived");
      return q;
    };

    // 1) Task serial — exact match on "T<n>".
    const taskMatch = sanitized.match(/^[Tt](\d+)$/);
    if (taskMatch) {
      const { data } = await baseQuery().eq("serial_display", `T${taskMatch[1]}`);
      setResults(splitBuckets((data ?? []) as Task[]));
      return;
    }

    // 2) Source-message serial — "G<n>", "S<n>", "W<n>", "E<n>", "D<n>", "C<n>".
    const srcMatch = sanitized.match(/^([GSWEDCgswedc])(\d+)$/);
    if (srcMatch) {
      const display = `${srcMatch[1].toUpperCase()}${srcMatch[2]}`;
      const { data: srcRows } = await supabase
        .from("source_messages")
        .select("id")
        .eq("user_id", user.id)
        .eq("serial_display", display)
        .limit(1);
      const srcIds = (srcRows ?? []).map((r: { id: string }) => r.id);
      if (srcIds.length === 0) {
        setResults({ suggestions: [], tasks: [] });
        return;
      }
      const { data } = await baseQuery().in("source_message_id", srcIds);
      setResults(splitBuckets((data ?? []) as Task[]));
      return;
    }

    // 3) Free-text across title / title_he / description.
    const term = `%${sanitized}%`;
    const { data } = await baseQuery()
      .or(`title.ilike.${term},title_he.ilike.${term},description.ilike.${term}`);
    setResults(splitBuckets((data ?? []) as Task[]));
  }

  function openDetail(task: Task) {
    setSelectedTask(task);
    setDetailOpen(true);
  }

  function handleDetailUpdate() {
    if (lastValueRef.current) runSearch(lastValueRef.current);
    onUpdate?.();
  }

  async function handleDelete(taskId: string) {
    if (!window.confirm(tTasks("actions.deleteConfirm"))) return;
    try {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      toast.success(tTasks("actions.deleted"));
      setDetailOpen(false);
      handleDetailUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  const hasResults =
    results !== null && (results.suggestions.length > 0 || results.tasks.length > 0);

  return (
    <div className="space-y-4">
      {/* One compact row: a small search field + the archive toggle beside it. */}
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={t("placeholder")}
            className="ps-8 pe-7 h-8 text-sm text-start"
          />
          {query && (
            <button
              type="button"
              onClick={() => handleChange("")}
              aria-label={t("clear")}
              title={t("clear")}
              className="absolute end-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={includeArchive}
            onChange={(e) => handleArchiveToggle(e.target.checked)}
          />
          {t("includeArchive")}
        </label>
      </div>

      {results === null ? (
        children
      ) : !hasResults ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noResults")}</p>
      ) : (
        <div className="space-y-4">
          {results.suggestions.length > 0 && (
            <ResultGroup
              label={t("groupSuggestions")}
              count={results.suggestions.length}
              tasks={results.suggestions}
              locale={locale}
              onSelect={openDetail}
            />
          )}
          {results.suggestions.length > 0 && results.tasks.length > 0 && <Separator />}
          {results.tasks.length > 0 && (
            <ResultGroup
              label={t("groupTasks")}
              count={results.tasks.length}
              tasks={results.tasks}
              locale={locale}
              onSelect={openDetail}
            />
          )}
        </div>
      )}

      <TaskDetail
        task={selectedTask}
        locale={locale}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onUpdate={handleDetailUpdate}
        onDelete={handleDelete}
      />
    </div>
  );
}

function ResultGroup({
  label,
  count,
  tasks,
  locale,
  onSelect,
}: {
  label: string;
  count: number;
  tasks: Task[];
  locale: string;
  onSelect: (t: Task) => void;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        <span className="ms-1 font-normal opacity-70">({count})</span>
      </h3>
      <div className="space-y-2">
        {tasks.map((task) => (
          <ResultCard key={task.id} task={task} locale={locale} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

function ResultCard({
  task,
  locale,
  onSelect,
}: {
  task: Task;
  locale: string;
  onSelect: (t: Task) => void;
}) {
  const t = useTranslations("tasks.search");
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const due = task.due_date
    ? formatDateOnly(task.due_date, locale, { day: "numeric", month: "short" })
    : null;
  const snoozedUntil = task.status === "snoozed" && task.snoozed_until
    ? new Date(task.snoozed_until).toLocaleString(locale === "he" ? "he-IL" : "en-US", {
        day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className="w-full rounded-lg border bg-card px-3 py-2.5 text-start transition-colors hover:bg-muted/50"
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <SerialBadge serial={task.serial_display} stopPropagation />
        {task.source_messages && <SourceLink source={task.source_messages} stopPropagation />}
        {task.projects && (
          <span className="inline-flex items-center rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {locale === "he" && task.projects.name_he ? task.projects.name_he : task.projects.name}
          </span>
        )}
        {/* A snoozed result says so — with when it wakes. */}
        {snoozedUntil && (
          <span className="inline-flex items-center gap-0.5 rounded-md bg-status-warn-bg px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
            <Clock className="h-3 w-3" />
            {t("snoozedUntil", { when: snoozedUntil })}
          </span>
        )}
        {due && <span className="text-[10px] text-muted-foreground">{due}</span>}
      </div>
      <div className="line-clamp-2 text-sm font-medium text-foreground">{title}</div>
    </button>
  );
}
