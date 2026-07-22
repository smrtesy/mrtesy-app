"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, CheckCircle2, Clock, ArrowRight, Link as LinkIcon, FileText, StickyNote, User, ExternalLink } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useOpenSmsChat, smsPeerFromSourceUrl } from "@/hooks/useOpenSmsChat";
import type { TaskMaterial, ChecklistItem, TaskNeed, TaskHandoff } from "@/types/task";
import { parseISO, gregShort, hebDate, countdownText } from "@/lib/smrtplan/dates";

const DONE_STATUSES = new Set(["completed", "archived", "dismissed"]);

interface DetailTask {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
  status: string;
  due_date: string | null;
  latest_finish: string | null;
  is_critical: boolean | null;
  plan_title_he: string | null;
  plan_title_en: string | null;
  stage_name_he: string | null;
  stage_name_en: string | null;
  task_materials: TaskMaterial[] | null;
  linked_drive_docs: { name: string; url: string }[] | null;
  checklist: ChecklistItem[] | null;
  source_messages?: { source_url: string | null; serial_display: string | null } | null;
  needs: TaskNeed[];
  handoff: TaskHandoff[];
}

interface DetailSubtask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  due_date: string | null;
  latest_finish: string | null;
}

interface SessionReport {
  session_id: string;
  session_url: string | null;
  summary: string;
  status: string; // "in_progress" | "blocked" | "done"
  updated_at: string;
}

const sessionStatusCls: Record<string, string> = {
  in_progress: "bg-status-warn-bg text-status-warn",
  blocked: "bg-status-late-bg text-status-late",
  done: "bg-status-ok-bg text-status-ok",
};

const materialIcon: Record<string, typeof LinkIcon> = {
  link: LinkIcon,
  file: FileText,
  note: StickyNote,
  contact: User,
};

/** Read-first task card for the worker views: description, materials, subtasks.
 *  The pencil (full access only) flips to a small edit form. */
export function TaskDetailDialog({
  taskId,
  open,
  onClose,
  locale,
  canEdit,
  onChanged,
}: {
  taskId: string | null;
  open: boolean;
  onClose: () => void;
  locale: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const openSms = useOpenSmsChat();
  const [task, setTask] = useState<DetailTask | null>(null);
  const [subtasks, setSubtasks] = useState<DetailSubtask[]>([]);
  const [sessionReports, setSessionReports] = useState<SessionReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fTitle, setFTitle] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fDue, setFDue] = useState("");
  const today = new Date();

  // Latest requested task — lets an in-flight fetch detect it lost a quick
  // task-switch race and drop its (stale) response instead of rendering it.
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = taskId;

  const load = useCallback(async () => {
    if (!taskId) return;
    const requestedId = taskId;
    setLoading(true);
    try {
      const { task, subtasks, session_reports } = await api<{
        task: DetailTask;
        subtasks: DetailSubtask[];
        session_reports: SessionReport[];
      }>(`/api/plan-tasks/${requestedId}/detail`);
      if (requestedId !== currentIdRef.current) return;
      setTask(task);
      setSubtasks(subtasks ?? []);
      setSessionReports(session_reports ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      if (requestedId === currentIdRef.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (open && taskId) {
      setEditing(false);
      setTask(null);
      setSessionReports([]);
      void load();
    }
  }, [open, taskId, load]);

  function startEdit() {
    if (!task) return;
    // Edit the locale-appropriate title field only, so saving never clobbers
    // the other language's title with this one.
    setFTitle(locale === "en" ? task.title : task.title_he || task.title);
    setFDescription(task.description ?? "");
    setFDue(task.due_date ?? "");
    setEditing(true);
  }

  async function save() {
    if (!task) return;
    setSaving(true);
    try {
      const titlePatch = locale === "en" ? { title: fTitle.trim() } : { title_he: fTitle.trim() };
      await api(`/api/plan-tasks/${task.id}`, {
        method: "PATCH",
        body: {
          ...titlePatch,
          description: fDescription.trim() || null,
          due_date: fDue || null,
        },
      });
      setEditing(false);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const title = task ? (locale === "en" ? task.title : task.title_he || task.title) : "";
  const planChip = task
    ? [
        locale === "en" ? task.plan_title_en || task.plan_title_he : task.plan_title_he,
        locale === "en" ? task.stage_name_en || task.stage_name_he : task.stage_name_he,
      ]
        .filter(Boolean)
        .join(" / ")
    : "";
  const deadline = task ? task.due_date || task.latest_finish : null;
  const materials = (task?.task_materials ?? []).filter(Boolean);
  const driveDocs = task?.linked_drive_docs ?? [];
  const checklist = task?.checklist ?? [];
  const sourceUrl = task?.source_messages?.source_url ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pe-6 text-start">
            {editing ? (
              <Input value={fTitle} onChange={(e) => setFTitle(e.target.value)} className="text-[15px] font-bold" />
            ) : (
              <>
                <span className="flex-1">{title}</span>
                {task?.is_critical && (
                  <span className="rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                    {t("tags.critical")}
                  </span>
                )}
                {canEdit && task && (
                  <button
                    onClick={startEdit}
                    title={t("my.detail.edit")}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading || !task ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-4 text-start">
            {/* plan / stage + deadline */}
            <div className="flex flex-wrap items-center gap-2">
              {planChip && (
                <span className="rounded bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">{planChip}</span>
              )}
              {editing ? (
                <DatePicker value={fDue} onChange={setFDue} className="w-44" />
              ) : (
                deadline &&
                !DONE_STATUSES.has(task.status) && (
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                    {countdownText(deadline, t, today)} · {gregShort(parseISO(deadline))} · {hebDate(parseISO(deadline))}
                  </span>
                )
              )}
            </div>

            {/* description */}
            <section>
              <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("my.detail.description")}</h3>
              {editing ? (
                <Textarea
                  value={fDescription}
                  onChange={(e) => setFDescription(e.target.value)}
                  rows={4}
                  className="text-[13px]"
                />
              ) : task.description ? (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{task.description}</p>
              ) : (
                <p className="text-[12.5px] italic text-muted-foreground">{t("my.detail.noDescription")}</p>
              )}
            </section>

            {/* Claude Code session report(s) — where the session opened for this
                task stands (summary + status + link), newest first. */}
            {sessionReports.length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("my.detail.sessionReport")}</h3>
                <div className="space-y-1.5">
                  {sessionReports.map((sr) => {
                    const statusLabel: Record<string, string> = {
                      in_progress: t("journal.statusInProgress"),
                      blocked: t("journal.statusBlocked"),
                      done: t("journal.statusDone"),
                    };
                    return (
                      <div key={sr.session_id} className="rounded-md border bg-card px-2.5 py-2">
                        <div className="mb-1 flex items-center gap-2">
                          <span
                            className={cn(
                              "whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold",
                              sessionStatusCls[sr.status] ?? "bg-secondary text-muted-foreground",
                            )}
                          >
                            {statusLabel[sr.status] ?? sr.status}
                          </span>
                          <span className="ms-auto whitespace-nowrap text-[10.5px] text-muted-foreground">
                            {gregShort(parseISO(sr.updated_at))}
                          </span>
                        </div>
                        {sr.summary && <p className="text-[12.5px] leading-relaxed">{sr.summary}</p>}
                        {sr.session_url && (
                          <a
                            href={sr.session_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-block text-[11.5px] font-medium text-primary hover:underline"
                          >
                            {t("journal.sessionLink")} ↗
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* materials + drive docs + source link */}
            {(materials.length > 0 || driveDocs.length > 0 || sourceUrl) && (
              <section>
                <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("my.detail.materials")}</h3>
                <div className="space-y-1">
                  {materials.map((m) => {
                    const Icon = materialIcon[m.type] ?? StickyNote;
                    const inner = (
                      <>
                        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{m.title || m.url}</span>
                      </>
                    );
                    return m.url ? (
                      <a
                        key={m.id}
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px] text-primary hover:bg-accent"
                      >
                        {inner}
                        <ExternalLink className="ms-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
                      </a>
                    ) : (
                      <div key={m.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px]">
                        {inner}
                        {m.content && <span className="truncate text-muted-foreground">· {m.content}</span>}
                      </div>
                    );
                  })}
                  {driveDocs.map((d, i) => (
                    <a
                      key={`drive-${i}`}
                      href={d.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px] text-primary hover:bg-accent"
                    >
                      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate">{d.name}</span>
                      <ExternalLink className="ms-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    </a>
                  ))}
                  {sourceUrl && (() => {
                    const srcCls =
                      "flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px] text-primary hover:bg-accent";
                    const srcInner = (
                      <>
                        <LinkIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{t("my.detail.source")}</span>
                        <ExternalLink className="ms-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
                      </>
                    );
                    // SMS sources open the in-app reader, not an `sms:` href.
                    const smsPeer = smsPeerFromSourceUrl(sourceUrl);
                    return smsPeer ? (
                      <button type="button" onClick={() => openSms(smsPeer)} className={cn(srcCls, "w-full text-start")}>
                        {srcInner}
                      </button>
                    ) : (
                      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className={srcCls}>
                        {srcInner}
                      </a>
                    );
                  })()}
                </div>
              </section>
            )}

            {/* checklist */}
            {checklist.length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("my.detail.checklist")}</h3>
                <div className="space-y-1">
                  {checklist.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-[12.5px]">
                      <span
                        className={cn(
                          "flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded text-white",
                          c.done ? "bg-status-ok" : "border border-muted-foreground/40 bg-transparent",
                        )}
                      >
                        {c.done && <CheckCircle2 className="h-3 w-3" />}
                      </span>
                      <span className={cn(c.done && "text-muted-foreground line-through")}>{c.title}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* subtasks */}
            {subtasks.length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("my.detail.subtasks")}</h3>
                <div className="space-y-1">
                  {subtasks.map((s) => {
                    const done = DONE_STATUSES.has(s.status);
                    const sDeadline = s.due_date || s.latest_finish;
                    return (
                      <div key={s.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12.5px]">
                        <span
                          className={cn(
                            "flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded text-white",
                            done ? "bg-status-ok" : "border border-dashed border-muted-foreground/40 bg-transparent",
                          )}
                        >
                          {done && <CheckCircle2 className="h-3 w-3" />}
                        </span>
                        <span className={cn("flex-1 truncate", done && "text-muted-foreground line-through")}>
                          {locale === "en" ? s.title : s.title_he || s.title}
                        </span>
                        {sDeadline && !done && (
                          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                            {gregShort(parseISO(sDeadline))}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* needs / handoff */}
            {(task.needs ?? []).length > 0 && (
              <section>
                <h3 className="mb-1 text-[12px] font-bold text-muted-foreground">{t("effort.needs")}</h3>
                <div className="space-y-1">
                  {(task.needs ?? []).map((n) => (
                    <div key={n.dependency_id} className="flex items-center gap-2 text-[12.5px]">
                      <span
                        className={cn(
                          "flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded text-white",
                          n.satisfied ? "bg-status-ok" : "bg-status-warn",
                        )}
                      >
                        {n.satisfied ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                      </span>
                      <span className="flex-1">{n.title}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {n.satisfied ? t("effort.arrived") : t("effort.waiting")}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {(task.handoff ?? []).length > 0 && (
              <div className="flex items-center gap-1.5 text-[12.5px] text-foreground/70">
                <ArrowRight className="h-3.5 w-3.5 text-status-ok" />
                <span className="text-[11px] font-bold text-muted-foreground">{t("effort.handoff")}:</span>
                {(task.handoff ?? []).map((h) => h.title).join(" · ")}
              </div>
            )}
          </div>
        )}

        {editing && (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditing(false)} disabled={saving}>
              {t("my.detail.cancel")}
            </Button>
            <Button onClick={save} disabled={saving || !fTitle.trim()}>
              {t("my.detail.save")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
