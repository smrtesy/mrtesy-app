"use client";

/**
 * MergeModal — two-step dialog for unifying N tasks/suggestions into one.
 *
 * Step 1: Choose target (new task or existing task lookup).
 * Step 2: AI proposes merged content; user can edit every field before confirming.
 *
 * Entry points (from caller's toolbar):
 *   • Suggestions screen with 1 selected → "merge into existing"
 *   • Suggestions screen with 2+ selected → "merge into new" (also offers existing)
 *   • Tasks screen with 2+ selected → "merge into new" (also offers existing)
 *
 * The component does NOT manage its own selection state — the caller passes
 * the array of source rows. On success, calls onMerged(result).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Sparkles, AlertTriangle, CheckCircle2, X, Plus, Search } from "lucide-react";

// ── types ──────────────────────────────────────────────────────────────────

interface MergeSourceLite {
  id: string;
  title?: string | null;
  title_he?: string | null;
  task_type?: string | null;
  status?: string | null;
  ai_confidence?: number | null;
}

interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  created_at?: string;
  completed_at?: string | null;
  created_by?: "user" | "ai";
  /** UI-only: which source row this item came from (for the badge). */
  source_task_id?: string;
}

interface AIProposal {
  merged_title?: string;
  merged_title_he?: string;
  merged_description?: string;
  suggested_checklist?: Array<{ title: string; source_task_id?: string }>;
  recommended_priority?: "urgent" | "high" | "medium" | "low";
  priority_reason?: string;
  recommended_due_date?: string | null;
  due_date_reason?: string;
  merged_keywords?: string[];
  merged_contacts?: string[];
  already_done_warnings?: Array<{ source_task_id: string; evidence: string; confidence: number }>;
  coherence_warning?: string | null;
}

interface MergeResult {
  merge_id: string;
  target_id: string;
  target_was_new: boolean;
  archived_count: number;
  completed_count: number;
  task: Record<string, unknown>;
}

interface TargetCandidate {
  id: string;
  title: string | null;
  title_he: string | null;
  due_date: string | null;
  priority: string | null;
  status: string | null;
}

/** Optional snapshot passed in when the parent has a completed AI proposal
 *  ready (e.g. after the user minimized the modal during AI loading and a
 *  background job finished). When provided, the modal opens at step 2 with
 *  these values applied — no fresh AI call is made. */
export interface MergeInitialState {
  proposal: AIProposal;
  targetMode: "new" | "existing";
  existingTargetId: string | null;
  /** Sources at the time the proposal was generated. Used so background
   *  resume matches the originally proposed merge even if the parent's
   *  current selection has changed. */
  sources: MergeSourceLite[];
}

export interface MergeModalProps {
  open: boolean;
  onClose: () => void;
  sources: MergeSourceLite[];
  /** When true, the caller comes from the tasks (not suggestions) screen.
   *  Affects the default tab choice and copy. */
  fromTasksList?: boolean;
  /** Locale for UI direction + default title selection. */
  locale: string;
  /** Called after a successful merge so the caller can refresh + show toast. */
  onMerged: (result: MergeResult) => void;
  /** When provided, the modal opens at step 2 using this snapshot instead
   *  of running step 1 + a fresh propose() call. Used by the background
   *  resume flow. */
  initialState?: MergeInitialState | null;
  /** Called when the user chooses "continue in background" while the AI is
   *  still loading. The modal hands the in-flight promise to the parent so
   *  the parent can await it after the dialog is dismissed and offer a
   *  "reopen" toast when ready. */
  onMinimize?: (job: MergeMinimizeJob) => void;
}

export interface MergeMinimizeJob {
  promise: Promise<AIProposal>;
  sources: MergeSourceLite[];
  targetMode: "new" | "existing";
  existingTargetId: string | null;
}

type Step = 1 | 2;
type TargetMode = "new" | "existing";

// ── helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  // Browser-safe enough for client-side UI IDs.
  return (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `ck-${Math.random().toString(36).slice(2, 10)}`;
}

function pickDefaultTitle(src: MergeSourceLite): { title: string; title_he: string } {
  return {
    title: src.title ?? src.title_he ?? "",
    title_he: src.title_he ?? src.title ?? "",
  };
}

// ── component ──────────────────────────────────────────────────────────────

export function MergeModal({ open, onClose, sources, fromTasksList, locale, onMerged, initialState, onMinimize }: MergeModalProps) {
  const t = useTranslations("merge");
  const supabase = useMemo(() => createClient(), []);

  /** Holds the in-flight propose() promise so "continue in background" can
   *  transfer ownership to the parent without re-running the request. */
  const inflightProposeRef = useRef<Promise<AIProposal> | null>(null);

  // Step + target
  const [step, setStep] = useState<Step>(1);
  const [targetMode, setTargetMode] = useState<TargetMode>(
    // Default: tasks screen → new (you can't easily merge a task into one of
    // the others as "the spine"); suggestions with exactly 1 selected → existing
    fromTasksList ? "new" : (sources.length === 1 ? "existing" : "new"),
  );
  const [existingTargetId, setExistingTargetId] = useState<string | null>(null);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<TargetCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  // Step 2 fields (the actual merged-task draft)
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AIProposal | null>(null);
  const [title, setTitle] = useState("");
  const [titleHe, setTitleHe] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"urgent" | "high" | "medium" | "low">("medium");
  const [dueDate, setDueDate] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [includeChecklist, setIncludeChecklist] = useState(true);
  /** Which sources the user accepted as "already done" (sent to backend as sources_completed). */
  const [sourcesCompleted, setSourcesCompleted] = useState<Set<string>>(new Set());
  /** Sources the user removed from the merge entirely (kept in state but excluded from POST). */
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const activeSourceIds = useMemo(
    () => sources.filter((s) => !excludedSources.has(s.id)).map((s) => s.id),
    [sources, excludedSources],
  );

  // Reset state every time we open with new sources, OR populate from
  // initialState when the parent resumed a background job.
  const lastInitKey = useRef<string>("");
  useEffect(() => {
    if (!open) return;
    // Distinct key: when initialState is present its proposal identity is
    // the key (each background resume gets a unique key), otherwise the
    // source-set key is used as before.
    const key = initialState
      ? `resume:${initialState.sources.map((s) => s.id).sort().join(",")}:${initialState.proposal.merged_title ?? ""}`
      : `fresh:${sources.map((s) => s.id).sort().join(",")}`;
    if (key === lastInitKey.current) return;
    lastInitKey.current = key;

    if (initialState) {
      // Resume an already-proposed merge — skip step 1 and the AI call.
      setStep(2);
      setTargetMode(initialState.targetMode);
      setExistingTargetId(initialState.existingTargetId);
      setProposal(initialState.proposal);
      setAiError(null);
      setAiLoading(false);
      applyProposalToFields(initialState.proposal, initialState.sources.map((s) => s.id));
    } else {
      setStep(1);
      setTargetMode(fromTasksList ? "new" : (sources.length === 1 ? "existing" : "new"));
      setExistingTargetId(null);
      setCandidateQuery("");
      setCandidates([]);
      setProposal(null);
      setAiError(null);
    }
    setExcludedSources(new Set());
    setSourcesCompleted(new Set());
    inflightProposeRef.current = null;
  }, [open, sources, fromTasksList, initialState]);

  /** Apply a proposal to the editable form fields. Extracted so both the
   *  AI-completion path and the background-resume path share the same logic. */
  function applyProposalToFields(p: AIProposal, activeIds: string[]) {
    setTitle(p.merged_title ?? "");
    setTitleHe(p.merged_title_he ?? "");
    setDescription(p.merged_description ?? "");
    setPriority((p.recommended_priority as typeof priority) ?? "medium");
    setDueDate(p.recommended_due_date ?? "");
    const activeIdSet = new Set(activeIds);
    const ck: ChecklistItem[] = (p.suggested_checklist ?? []).map((it) => ({
      id: uuid(),
      title: it.title,
      done: false,
      created_by: "ai" as const,
      source_task_id: it.source_task_id && activeIdSet.has(it.source_task_id)
        ? it.source_task_id
        : undefined,
    }));
    setChecklist(ck);
    setIncludeChecklist(ck.length > 0);
  }

  // ── Step 1: candidate lookup (existing target search) ───────────────────
  useEffect(() => {
    if (step !== 1 || targetMode !== "existing") return;
    let cancelled = false;
    setCandidatesLoading(true);

    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        let q = supabase
          .from("tasks")
          .select("id, title, title_he, due_date, priority, status")
          .eq("user_id", user.id)
          .in("status", ["inbox", "in_progress", "snoozed"])
          .order("updated_at", { ascending: false })
          .limit(40);
        if (candidateQuery.trim().length > 1) {
          // Match either title or title_he against the query.
          const term = candidateQuery.trim();
          q = q.or(`title.ilike.%${term}%,title_he.ilike.%${term}%`);
        }
        const { data } = await q;
        if (!cancelled) {
          // Filter out any source rows from the candidate list.
          const sourceIdSet = new Set(sources.map((s) => s.id));
          setCandidates((data ?? []).filter((row: TargetCandidate) => !sourceIdSet.has(row.id)));
        }
      } finally {
        if (!cancelled) setCandidatesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [step, targetMode, candidateQuery, sources, supabase]);

  // ── Step 1 → Step 2: invoke AI ──────────────────────────────────────────
  const goToStep2 = useCallback(async () => {
    if (targetMode === "existing" && !existingTargetId) {
      toast.error(t("selectTargetFirst"));
      return;
    }

    setStep(2);
    setAiLoading(true);
    setAiError(null);
    setProposal(null);

    // Wrap the fetch so we can store the promise in a ref. That way
    // "continue in background" can hand it to the parent without
    // re-triggering the request.
    const proposePromise = api<{ proposal: AIProposal }>("/api/tasks/merge/propose", {
      method: "POST",
      body: {
        source_task_ids: activeSourceIds,
        target_task_id: targetMode === "existing" ? existingTargetId : undefined,
      },
    }).then((r) => r.proposal);
    inflightProposeRef.current = proposePromise;

    try {
      const proposal = await proposePromise;
      // If the user minimized in the meantime, the parent now owns the
      // promise — don't fight it for state ownership.
      if (inflightProposeRef.current !== proposePromise) return;
      const p = proposal ?? ({} as AIProposal);
      setProposal(p);
      applyProposalToFields(p, activeSourceIds);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setAiError(msg);
      // Even on AI failure, allow manual fallback: pre-fill from the first
      // active source so the user isn't blocked.
      const seed = sources.find((s) => activeSourceIds.includes(s.id));
      if (seed) {
        const d = pickDefaultTitle(seed);
        setTitle(d.title);
        setTitleHe(d.title_he);
      }
    } finally {
      setAiLoading(false);
    }
  }, [targetMode, existingTargetId, activeSourceIds, sources, t]);

  // ── Step 2 → submit merge ───────────────────────────────────────────────
  const submitMerge = useCallback(async () => {
    if (activeSourceIds.length < 1) {
      toast.error(t("noSourcesLeft"));
      return;
    }
    if (!title && !titleHe) {
      toast.error(t("titleRequired"));
      return;
    }

    // Derive merge_kind from inputs (matches the server CHECK).
    let merge_kind: string;
    const allSuggestions = sources
      .filter((s) => activeSourceIds.includes(s.id))
      .every((s) => s.status === "inbox" || s.status === "snoozed" || s.task_type === "project_suggestion");
    if (targetMode === "existing") merge_kind = "suggestion_into_existing";
    else if (allSuggestions) merge_kind = "suggestions_into_new";
    else merge_kind = "tasks_into_new";

    const cleanedChecklist: ChecklistItem[] = includeChecklist
      ? checklist
          .filter((c) => c.title.trim().length > 0)
          .map(({ id, title: cTitle, done, created_by }) => ({
            id, title: cTitle.trim(), done, created_by: created_by ?? "ai",
            created_at: new Date().toISOString(),
            completed_at: null,
          }))
      : [];

    const body: Record<string, unknown> = {
      source_task_ids: activeSourceIds,
      merge_kind,
      sources_completed: Array.from(sourcesCompleted).filter((id) => activeSourceIds.includes(id)),
      ai_proposal: proposal ?? null,
    };

    if (targetMode === "existing") {
      body.target = { mode: "existing", task_id: existingTargetId };
      body.target_updates = {
        title: title || undefined,
        title_he: titleHe || undefined,
        description: description || undefined,
        priority,
        due_date: dueDate || undefined,
        checklist: cleanedChecklist,
      };
    } else {
      body.target = {
        mode: "new",
        title: title || titleHe,
        title_he: titleHe || title,
        description,
        priority,
        due_date: dueDate || undefined,
        checklist: cleanedChecklist,
      };
    }

    setSubmitting(true);
    try {
      const result = await api<MergeResult>("/api/tasks/merge", {
        method: "POST",
        body,
      });
      onMerged(result);
      onClose();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [
    activeSourceIds, title, titleHe, description, priority, dueDate, checklist,
    includeChecklist, sourcesCompleted, proposal, targetMode, existingTargetId,
    sources, onMerged, onClose, t,
  ]);

  // ── render ──────────────────────────────────────────────────────────────

  const visibleSources = sources.filter((s) => !excludedSources.has(s.id));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 1 ? t("step1Title") : t("step2Title")}
            <Badge variant="outline" className="ml-2">
              {t("stepXofY", { current: step, total: 2 })}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-2">
          {step === 1 && (
            <Step1
              targetMode={targetMode}
              onTargetModeChange={setTargetMode}
              sourceCount={visibleSources.length}
              candidateQuery={candidateQuery}
              onCandidateQueryChange={setCandidateQuery}
              candidates={candidates}
              candidatesLoading={candidatesLoading}
              existingTargetId={existingTargetId}
              onExistingTargetChange={setExistingTargetId}
              fromTasksList={!!fromTasksList}
              t={t}
              locale={locale}
            />
          )}

          {step === 2 && (
            <Step2
              aiLoading={aiLoading}
              aiError={aiError}
              proposal={proposal}
              sources={visibleSources}
              onRemoveSource={(id) => setExcludedSources((prev) => new Set(prev).add(id))}
              sourcesCompleted={sourcesCompleted}
              onToggleCompleted={(id) => setSourcesCompleted((prev) => {
                const n = new Set(prev);
                if (n.has(id)) n.delete(id); else n.add(id);
                return n;
              })}
              title={title} setTitle={setTitle}
              titleHe={titleHe} setTitleHe={setTitleHe}
              description={description} setDescription={setDescription}
              priority={priority} setPriority={setPriority}
              dueDate={dueDate} setDueDate={setDueDate}
              checklist={checklist} setChecklist={setChecklist}
              includeChecklist={includeChecklist} setIncludeChecklist={setIncludeChecklist}
              t={t}
              locale={locale}
            />
          )}
        </ScrollArea>

        <DialogFooter className="flex-row justify-between gap-2">
          {step === 1 ? (
            <>
              <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
              <Button
                onClick={goToStep2}
                disabled={targetMode === "existing" && !existingTargetId}
              >
                {t("continueToPreview")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep(1)} disabled={submitting || aiLoading}>
                {t("back")}
              </Button>
              <div className="flex gap-2">
                {aiLoading && onMinimize && inflightProposeRef.current && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const promise = inflightProposeRef.current;
                      if (!promise) return;
                      // Hand the promise to the parent so the request keeps
                      // running after we close. Mark the ref null so the
                      // modal's own await won't try to apply the result.
                      onMinimize({
                        promise,
                        sources: visibleSources,
                        targetMode,
                        existingTargetId,
                      });
                      inflightProposeRef.current = null;
                      onClose();
                    }}
                  >
                    {t("minimize")}
                  </Button>
                )}
                <Button variant="ghost" onClick={onClose} disabled={submitting}>
                  {t("cancel")}
                </Button>
                <Button onClick={submitMerge} disabled={submitting || aiLoading}>
                  {submitting ? t("merging") : t("confirmMerge")}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1 ─────────────────────────────────────────────────────────────────

interface Step1Props {
  targetMode: TargetMode;
  onTargetModeChange: (m: TargetMode) => void;
  sourceCount: number;
  candidateQuery: string;
  onCandidateQueryChange: (q: string) => void;
  candidates: TargetCandidate[];
  candidatesLoading: boolean;
  existingTargetId: string | null;
  onExistingTargetChange: (id: string | null) => void;
  fromTasksList: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

function Step1(props: Step1Props) {
  const { targetMode, onTargetModeChange, candidateQuery, onCandidateQueryChange,
    candidates, candidatesLoading, existingTargetId, onExistingTargetChange, t, locale } = props;

  return (
    <Tabs value={targetMode} onValueChange={(v) => onTargetModeChange(v as TargetMode)} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="new">{t("targetNew")}</TabsTrigger>
        <TabsTrigger value="existing">{t("targetExisting")}</TabsTrigger>
      </TabsList>

      <TabsContent value="new" className="py-4 text-sm text-muted-foreground">
        {t("targetNewHelp", { count: props.sourceCount })}
      </TabsContent>

      <TabsContent value="existing" className="py-4 space-y-3">
        <div className="relative">
          <Search className="absolute top-1/2 -translate-y-1/2 start-2 h-4 w-4 text-muted-foreground" />
          <Input
            value={candidateQuery}
            onChange={(e) => onCandidateQueryChange(e.target.value)}
            placeholder={t("searchTargetPlaceholder")}
            className="ps-8"
            dir="auto"
          />
        </div>

        <div className="border rounded-md max-h-80 overflow-y-auto">
          {candidatesLoading && (
            <div className="p-3 space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-6 w-5/6" />
            </div>
          )}
          {!candidatesLoading && candidates.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {t("noCandidates")}
            </div>
          )}
          {!candidatesLoading && candidates.map((c) => {
            const label = locale === "he" ? (c.title_he ?? c.title) : (c.title ?? c.title_he);
            const isSelected = existingTargetId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onExistingTargetChange(c.id)}
                className={`w-full text-start px-3 py-2 hover:bg-muted/50 border-b last:border-b-0 flex items-center gap-2 ${isSelected ? "bg-muted/70" : ""}`}
              >
                <div className={`h-3 w-3 rounded-full border ${isSelected ? "bg-primary border-primary" : "border-muted-foreground/40"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{label}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.status}{c.due_date ? ` · ${c.due_date}` : ""}{c.priority ? ` · ${c.priority}` : ""}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </TabsContent>
    </Tabs>
  );
}

// ── Step 2 ─────────────────────────────────────────────────────────────────

interface Step2Props {
  aiLoading: boolean;
  aiError: string | null;
  proposal: AIProposal | null;
  sources: MergeSourceLite[];
  onRemoveSource: (id: string) => void;
  sourcesCompleted: Set<string>;
  onToggleCompleted: (id: string) => void;
  title: string; setTitle: (s: string) => void;
  titleHe: string; setTitleHe: (s: string) => void;
  description: string; setDescription: (s: string) => void;
  priority: "urgent" | "high" | "medium" | "low";
  setPriority: (p: "urgent" | "high" | "medium" | "low") => void;
  dueDate: string; setDueDate: (s: string) => void;
  checklist: ChecklistItem[]; setChecklist: (c: ChecklistItem[]) => void;
  includeChecklist: boolean; setIncludeChecklist: (b: boolean) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

function Step2(props: Step2Props) {
  const { aiLoading, aiError, proposal, sources, onRemoveSource,
    sourcesCompleted, onToggleCompleted,
    title, setTitle, titleHe, setTitleHe, description, setDescription,
    priority, setPriority, dueDate, setDueDate,
    checklist, setChecklist, includeChecklist, setIncludeChecklist, t, locale } = props;

  const updateChecklistItem = (id: string, patch: Partial<ChecklistItem>) => {
    setChecklist(checklist.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const removeChecklistItem = (id: string) => setChecklist(checklist.filter((c) => c.id !== id));
  const addChecklistItem = () => setChecklist([
    ...checklist,
    { id: uuid(), title: "", done: false, created_by: "user" },
  ]);

  if (aiLoading) {
    return (
      <div className="py-8 flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <Sparkles className="h-6 w-6 text-primary animate-pulse" />
        <div>{t("aiThinking")}</div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      {aiError && (
        <div className="rounded-md border border-status-warn/30 bg-status-warn-bg p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-status-warn flex-shrink-0" />
          <div>
            <div className="font-medium">{t("aiFailed")}</div>
            <div className="text-muted-foreground text-xs">{aiError}</div>
          </div>
        </div>
      )}

      {proposal?.coherence_warning && (
        <div className="rounded-md border border-primary/30 bg-accent p-3 text-sm flex items-start gap-2">
          <Sparkles className="h-4 w-4 mt-0.5 text-primary flex-shrink-0" />
          <div className="flex-1">{proposal.coherence_warning}</div>
        </div>
      )}

      {/* Sources list — user can remove any from the merge */}
      <section>
        <div className="text-xs font-medium text-muted-foreground mb-1">{t("sourcesSection")}</div>
        <div className="space-y-1">
          {sources.map((s) => {
            const label = locale === "he" ? (s.title_he ?? s.title) : (s.title ?? s.title_he);
            const warning = proposal?.already_done_warnings?.find((w) => w.source_task_id === s.id);
            const isMarkedDone = sourcesCompleted.has(s.id);
            return (
              <div key={s.id} className="rounded border p-2 text-sm flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="truncate">{label}</div>
                  {warning && (
                    <div className="mt-1 text-xs flex items-start gap-1 text-status-warn">
                      <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                      <div>
                        <div>{t("alreadyDoneHint")}</div>
                        <div className="text-muted-foreground italic">&ldquo;{warning.evidence}&rdquo;</div>
                        <div className="mt-1 flex gap-2">
                          <button
                            type="button"
                            className={`underline ${isMarkedDone ? "text-status-ok" : ""}`}
                            onClick={() => onToggleCompleted(s.id)}
                          >
                            {isMarkedDone ? t("markedAsDone") : t("markAsDone")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onRemoveSource(s.id)}
                  title={t("removeFromMerge")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Title */}
      <section className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          {t("titleField")} {proposal && <Sparkles className="h-3 w-3 text-primary" />}
        </label>
        <Input value={titleHe} onChange={(e) => setTitleHe(e.target.value)} placeholder={t("titleHePlaceholder")} dir="auto" />
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("titleEnPlaceholder")} dir="auto" />
      </section>

      {/* Description */}
      <section className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          {t("descriptionField")} {proposal && <Sparkles className="h-3 w-3 text-primary" />}
        </label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          dir="auto"
          placeholder={t("descriptionPlaceholder")}
        />
      </section>

      {/* Checklist */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            {t("checklistField")} {proposal && <Sparkles className="h-3 w-3 text-primary" />}
          </label>
          <label className="text-xs flex items-center gap-1">
            <input
              type="checkbox"
              checked={includeChecklist}
              onChange={(e) => setIncludeChecklist(e.target.checked)}
            />
            {t("includeChecklist")}
          </label>
        </div>
        {includeChecklist && (
          <div className="space-y-1">
            {checklist.map((c) => (
              <div key={c.id} className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 mt-2 text-muted-foreground flex-shrink-0" />
                <Input
                  value={c.title}
                  onChange={(e) => updateChecklistItem(c.id, { title: e.target.value })}
                  dir="auto"
                  className="flex-1"
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive p-2"
                  onClick={() => removeChecklistItem(c.id)}
                  title={t("removeChecklistItem")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="gap-1" onClick={addChecklistItem}>
              <Plus className="h-3 w-3" />
              {t("addChecklistItem")}
            </Button>
          </div>
        )}
      </section>

      {/* Priority + due_date */}
      <section className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            {t("priorityField")} {proposal && <Sparkles className="h-3 w-3 text-primary" />}
          </label>
          <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="urgent">{t("priorityUrgent")}</SelectItem>
              <SelectItem value="high">{t("priorityHigh")}</SelectItem>
              <SelectItem value="medium">{t("priorityMedium")}</SelectItem>
              <SelectItem value="low">{t("priorityLow")}</SelectItem>
            </SelectContent>
          </Select>
          {proposal?.priority_reason && (
            <div className="text-xs text-muted-foreground italic">{proposal.priority_reason}</div>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            {t("dueDateField")} {proposal && <Sparkles className="h-3 w-3 text-primary" />}
          </label>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          {proposal?.due_date_reason && (
            <div className="text-xs text-muted-foreground italic">{proposal.due_date_reason}</div>
          )}
        </div>
      </section>

      {/* Tags from AI (read-only display) */}
      {proposal?.merged_keywords && proposal.merged_keywords.length > 0 && (
        <section className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            {t("keywordsField")} <Sparkles className="h-3 w-3 text-primary" />
          </label>
          <div className="flex flex-wrap gap-1">
            {proposal.merged_keywords.map((k) => (
              <Badge key={k} variant="secondary">{k}</Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
