"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, X, Bell } from "lucide-react";
import { toast } from "sonner";
import { SourceLink } from "@/components/smrttask/common/SourceLink";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { useAITrail, AITrailIconButton, AITrailBody } from "@/components/smrttask/common/AITrail";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { DismissDialog } from "./DismissDialog";

interface SourceJoin {
  source_type: string | null;
  source_url: string | null;
  serial_display: string | null;
}

export function MessageSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const tTasks = useTranslations("tasks");
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, count } = await supabase
      .from("tasks")
      .select("*, source_messages(source_type, source_url, serial_display)", { count: "exact" })
      .eq("user_id", user.id)
      .eq("status", "inbox")
      .eq("manually_verified", false)
      .not("source_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000);  // PostgREST default cap; the user wants to see every pending suggestion

    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const sorted = (data || []).sort(
      (a: any, b: any) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) // eslint-disable-line @typescript-eslint/no-explicit-any
    );
    setSuggestions(sorted);
    setTotalCount(count ?? sorted.length);
    setSelected(new Set());
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  // Client-side filter on the loaded list. Server pagination is capped at 1000
  // which is well above the realistic backlog size, so filtering locally keeps
  // the search snappy without round-trips.
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return suggestions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return suggestions.filter((task: any) => {
      const haystack = [
        task.title,
        task.title_he,
        task.description,
        task.related_contact,
        task.related_contact_email,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [suggestions, searchQuery]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected(new Set(filtered.map((t: any) => t.id as string))); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  function clearSelection() { setSelected(new Set()); }

  async function handleApprove(taskId: string) {
    await supabase
      .from("tasks")
      .update({ manually_verified: true, seen_at: new Date().toISOString() })
      .eq("id", taskId);
    toast.success(t("approve"));
    fetchSuggestions();
  }

  async function handleFastDismiss(taskId: string) {
    try {
      await api(`/api/tasks/${taskId}/dismiss-fast`, { method: "POST" });
      toast.success(t("fastDismissed"));
      fetchSuggestions();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api(`/api/tasks/bulk-approve`, { method: "POST", body: { task_ids: ids } });
      toast.success(t("approve"));
      fetchSuggestions();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleBulkDismissFast() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api(`/api/tasks/bulk-dismiss-fast`, { method: "POST", body: { task_ids: ids } });
      toast.success(t("fastDismissed"));
      fetchSuggestions();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function openDismissDialog(taskId: string, title: string) {
    setDismissTarget({ id: taskId, title });
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Bell className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noSuggestions")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SuggestionToolbar
        total={totalCount || suggestions.length}
        filtered={filtered.length}
        selectedCount={selected.size}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelectAll={selectAllFiltered}
        onClearSelection={clearSelection}
        onBulkApprove={handleBulkApprove}
        onBulkDismissFast={handleBulkDismissFast}
      />

      {filtered.length === 0 && (
        <div className="py-8 text-center text-muted-foreground text-sm">
          {t("noSuggestions")}
        </div>
      )}

      {filtered.map((task: any) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
        const source = (Array.isArray(task.source_messages) ? task.source_messages[0] : task.source_messages) as SourceJoin | null;
        const title = locale === "he" && task.title_he ? task.title_he : task.title;
        const dueDate = task.due_date
          ? new Date(task.due_date as string).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", { day: "numeric", month: "short" })
          : null;
        const isSelected = selected.has(task.id);

        return (
          <Card key={task.id} className={isSelected ? "ring-2 ring-primary/50" : undefined}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(task.id as string)}
                  className="mt-2 shrink-0 h-4 w-4 cursor-pointer"
                  aria-label={t("selectAll")}
                />
                <div className="mt-1 rounded-full bg-blue-100 p-2">
                  <Bell className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-sm" dir="auto">{title}</h4>
                    <SerialBadge serial={task.serial_display as string | null} />
                    <SourceLink source={source} />
                    {dueDate && (
                      <Badge variant="outline" className="text-[10px] bg-blue-50 shrink-0">
                        {dueDate}
                      </Badge>
                    )}
                  </div>
                  {task.description ? (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2" dir="auto">
                      {task.description}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {task.related_contact && (
                      <Badge variant="outline" className="text-[10px]">
                        {task.related_contact as string}
                      </Badge>
                    )}
                    {task.priority && (
                      <Badge variant="secondary" className="text-[10px]">
                        {tTasks(`priority.${task.priority}`)}
                      </Badge>
                    )}
                    {(task.tags as string[] | null)?.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] capitalize">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              <SuggestionActions
                taskId={task.id as string}
                onFastDismiss={() => handleFastDismiss(task.id as string)}
                onDismissWithReason={() => openDismissDialog(task.id as string, (locale === "he" && task.title_he ? task.title_he : task.title) as string)}
                onApprove={() => handleApprove(task.id as string)}
              />
            </CardContent>
          </Card>
        );
      })}

      <DismissDialog
        taskId={dismissTarget?.id ?? null}
        taskTitle={dismissTarget?.title}
        open={!!dismissTarget}
        onClose={() => setDismissTarget(null)}
        onDismissed={fetchSuggestions}
      />
    </div>
  );
}

/**
 * Per-card action row: AI trail icon (rightmost in RTL) + fast-X (red) + X! (orange)
 * + approve. The AI trail body expands inline below the row when toggled.
 */
function SuggestionActions({
  taskId,
  onFastDismiss,
  onDismissWithReason,
  onApprove,
}: {
  taskId: string;
  onFastDismiss: () => void;
  onDismissWithReason: () => void;
  onApprove: () => void;
}) {
  const t = useTranslations("suggestions");
  const trail = useAITrail(taskId);

  return (
    <>
      <div className="flex gap-2 mt-3 items-center">
        <AITrailIconButton open={trail.open} onToggle={trail.toggle} />
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-9 min-w-[48px] gap-1 text-red-500 hover:text-red-600 hover:bg-red-50"
          onClick={onFastDismiss}
          title={t("fastDismiss")}
          aria-label={t("fastDismiss")}
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 min-w-[48px] gap-0 text-orange-500 hover:text-orange-600 hover:bg-orange-50 font-semibold"
          onClick={onDismissWithReason}
          title={t("dismissWithReason")}
          aria-label={t("dismissWithReason")}
        >
          <X className="h-4 w-4" />
          <span className="text-sm leading-none -ms-0.5">!</span>
        </Button>
        <Button
          size="sm"
          className="h-9 min-w-[48px] gap-1"
          onClick={onApprove}
        >
          <CheckCircle2 className="h-4 w-4" />
          {t("approve")}
        </Button>
      </div>

      {trail.open && (
        <AITrailBody
          data={trail.data}
          loading={trail.loading}
          error={trail.error}
          className="mt-2"
        />
      )}
    </>
  );
}
