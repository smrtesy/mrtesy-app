"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";
import { SerialBadge } from "@/components/smrttask/common/SerialBadge";
import { SuggestionToolbar } from "@/components/smrttask/common/SuggestionToolbar";
import { DismissDialog } from "./DismissDialog";
import { MergeModal, type MergeInitialState, type MergeMinimizeJob } from "@/components/smrttask/merge/MergeModal";

interface SuggestionTask {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
  serial_display: string | null;
}

export function ProjectSuggestions({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const tMerge = useTranslations("merge");
  const [suggestions, setSuggestions] = useState<SuggestionTask[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [resumedMerge, setResumedMerge] = useState<MergeInitialState | null>(null);

  const handleMinimize = useCallback((job: MergeMinimizeJob) => {
    toast.info(tMerge("bgRunningToast"));
    job.promise.then((proposal) => {
      setResumedMerge({
        proposal,
        targetMode: job.targetMode,
        existingTargetId: job.existingTargetId,
        sources: job.sources,
      });
      toast.success(tMerge("bgReadyToast"), {
        action: { label: tMerge("openMerge"), onClick: () => setMergeOpen(true) },
        duration: 30_000,
      });
    }).catch(() => {
      toast.error(tMerge("bgFailedToast"));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string } | null>(null);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const { tasks } = await api<{ tasks: SuggestionTask[] }>(
        "/api/tasks?task_type=project_suggestion&status=inbox&limit=100",
      );
      setSuggestions(tasks ?? []);
      setSelected(new Set());
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.filter((task) => {
      const haystack = [task.title, task.title_he, task.description].filter(Boolean).join(" ").toLowerCase();
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

  function selectAllFiltered() { setSelected(new Set(filtered.map((t) => t.id))); }
  function clearSelection() { setSelected(new Set()); }

  async function handleApprove(task: SuggestionTask) {
    try {
      await api(`/api/tasks/${task.id}/approve-as-project`, { method: "POST" });
      toast.success(t("projectCreated"));
      fetchSuggestions();
    } catch (e) {
      toast.error((e as Error).message);
    }
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

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Lightbulb className="mx-auto h-8 w-8 mb-2 opacity-50" />
        <p>{t("noProjects")}</p>
        <p className="text-xs mt-1">{t("projectsDetectedNightly")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SuggestionToolbar
        total={suggestions.length}
        filtered={filtered.length}
        selectedCount={selected.size}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelectAll={selectAllFiltered}
        onClearSelection={clearSelection}
        onBulkDismissFast={handleBulkDismissFast}
        onBulkMerge={selected.size >= 1 ? () => setMergeOpen(true) : undefined}
      />

      {filtered.length === 0 && (
        <div className="py-8 text-center text-muted-foreground text-sm">{t("noProjects")}</div>
      )}

      {filtered.map((task) => {
        const title = locale === "he" && task.title_he ? task.title_he : task.title;
        const isSelected = selected.has(task.id);
        return (
          <Card key={task.id} className={isSelected ? "ring-2 ring-primary/50" : undefined}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(task.id)}
                  className="mt-2 shrink-0 h-4 w-4 cursor-pointer"
                  aria-label={t("selectAll")}
                />
                <div className="mt-1 rounded-full bg-yellow-100 p-2">
                  <Lightbulb className="h-4 w-4 text-yellow-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-sm" dir="auto">{title}</h4>
                    <SerialBadge serial={task.serial_display} />
                  </div>
                  {task.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2" dir="auto">
                      {task.description}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 mt-3 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-1 text-red-500 hover:text-red-600 hover:bg-red-50"
                  onClick={() => handleFastDismiss(task.id)}
                  title={t("fastDismiss")}
                  aria-label={t("fastDismiss")}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-0 text-orange-500 hover:text-orange-600 hover:bg-orange-50 font-semibold"
                  onClick={() => setDismissTarget({ id: task.id, title })}
                  title={t("dismissWithReason")}
                  aria-label={t("dismissWithReason")}
                >
                  <X className="h-4 w-4" />
                  <span className="text-sm leading-none -ms-0.5">!</span>
                </Button>
                <Button
                  size="sm"
                  className="h-9 gap-1"
                  onClick={() => handleApprove(task)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("createProject")}
                </Button>
              </div>
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

      <MergeModal
        open={mergeOpen}
        onClose={() => { setMergeOpen(false); setResumedMerge(null); }}
        sources={resumedMerge?.sources ?? suggestions
          .filter((s) => selected.has(s.id))
          .map((s) => ({
            id: s.id,
            title: s.title,
            title_he: s.title_he,
            task_type: "project_suggestion",
            status: "inbox",
          }))}
        locale={locale}
        initialState={resumedMerge}
        onMinimize={handleMinimize}
        onMerged={() => {
          toast.success(tMerge("successToast"));
          setResumedMerge(null);
          fetchSuggestions();
        }}
      />
    </div>
  );
}
