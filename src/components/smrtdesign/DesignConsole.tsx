"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useOpenTab } from "@/components/platform/layout/OpenTabLink";

const DIMENSIONS = [
  "typography",
  "color",
  "neutral",
  "layout",
  "motion",
  "signature",
  "voice",
] as const;
type Dimension = (typeof DIMENSIONS)[number];

interface ProjectRow {
  id: string;
  name: string;
  subject: string;
  languages: string[];
  status: string;
  option_count: number;
  mode?: string;
}
interface OptionRow {
  id: string;
  round: number;
  anchor: string | null;
  title: string | null;
  spec_json: Record<string, unknown>;
  is_combined: boolean;
  is_locked: boolean;
  image_signed_url: string | null;
}
interface ProjectDetail {
  project: ProjectRow & { audience: string | null; thread_id: string | null };
  options: OptionRow[];
}

interface ThreadLite {
  id: string;
  title: string | null;
}

export function DesignConsole() {
  const t = useTranslations("smrtDesign");
  const locale = useLocale();
  const openTab = useOpenTab();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picks, setPicks] = useState<Partial<Record<Dimension, string>>>({});

  // Link-existing-conversation (option A) picker
  const [linking, setLinking] = useState(false);
  const [threads, setThreads] = useState<ThreadLite[] | null>(null);
  const [linkThreadId, setLinkThreadId] = useState("");

  // New-project form
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [audience, setAudience] = useState("");
  const [langHe, setLangHe] = useState(true);
  const [langEn, setLangEn] = useState(true);
  const [optionCount, setOptionCount] = useState(4);

  const loadProjects = useCallback(async () => {
    try {
      const { projects } = await api<{ projects: ProjectRow[] }>("/api/design/projects");
      setProjects(projects);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api<ProjectDetail>(`/api/design/projects/${id}`);
      setDetail(d);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // Poll while a run is generating OR a conversation is active — new renders can
  // arrive at any time from the console chat (conversation mode keeps status at
  // 'generating' until an option is locked).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (detail?.project.status === "generating" && selectedId) {
      pollRef.current = setInterval(() => void loadDetail(selectedId), 7000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [detail?.project.status, selectedId, loadDetail]);

  async function createProject() {
    if (!name.trim() || !subject.trim()) {
      toast.error(t("nameSubjectRequired"));
      return;
    }
    const languages = [langHe && "he", langEn && "en"].filter(Boolean) as string[];
    setBusy(true);
    try {
      const { project } = await api<{ project: ProjectRow }>("/api/design/projects", {
        method: "POST",
        body: { name, subject, audience, languages: languages.length ? languages : ["he"], option_count: optionCount },
      });
      toast.success(t("projectCreated"));
      setName("");
      setSubject("");
      setAudience("");
      setCreating(false);
      await loadProjects();
      setSelectedId(project.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Primary flow: open (or continue) the interactive design conversation in the
   *  built-in Claude console. Renders made there land in this gallery. */
  async function openConversation() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const { console_path } = await api<{ thread_id: string; console_path: string }>(
        `/api/design/projects/${selectedId}/open`,
        { method: "POST" },
      );
      await loadDetail(selectedId);
      openTab(`/${locale}${console_path}`, t("conversationTab"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Secondary flow: fire N options automatically in one background run. */
  async function generateAuto() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/design/projects/${selectedId}/generate`, { method: "POST" });
      toast.success(t("generationStarted"));
      await loadDetail(selectedId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Option A: load the org's recent Claude conversations to link one. Best-effort
   *  — the console list requires admin; if it 403s we just fall back to a paste box. */
  async function toggleLinking() {
    const next = !linking;
    setLinking(next);
    if (next && threads === null) {
      try {
        const { threads } = await api<{ threads: ThreadLite[] }>("/api/claude/threads");
        setThreads(threads);
      } catch {
        setThreads([]);
      }
    }
  }

  async function linkThread() {
    if (!selectedId || !linkThreadId) {
      toast.error(t("pickThread"));
      return;
    }
    setBusy(true);
    try {
      const { console_path } = await api<{ thread_id: string; console_path: string }>(
        `/api/design/projects/${selectedId}/link-thread`,
        { method: "POST", body: { thread_id: linkThreadId } },
      );
      toast.success(t("linked"));
      setLinking(false);
      setLinkThreadId("");
      await loadDetail(selectedId);
      openTab(`/${locale}${console_path}`, t("conversationTab"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lockOption(optionId: string) {
    if (!selectedId) return;
    try {
      await api(`/api/design/options/${optionId}/lock`, { method: "POST" });
      toast.success(t("locked"));
      await loadDetail(selectedId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remix() {
    if (!selectedId || Object.keys(picks).length === 0) {
      toast.error(t("pickAtLeastOne"));
      return;
    }
    setBusy(true);
    try {
      await api(`/api/design/projects/${selectedId}/remix`, { method: "POST", body: { picks } });
      toast.success(t("remixStarted"));
      await loadDetail(selectedId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const options = detail?.options ?? [];
  const hasThread = Boolean(detail?.project.thread_id);
  const isConversation = detail?.project.mode !== "auto"; // default/unset = conversation

  return (
    <div className="space-y-6">
      {/* Projects bar */}
      <div className="flex flex-wrap items-center gap-2">
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={
              "rounded-md border px-3 py-1.5 text-sm " +
              (p.id === selectedId ? "border-foreground bg-muted font-semibold" : "border-border text-muted-foreground")
            }
          >
            {p.name}
          </button>
        ))}
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? t("cancel") : t("newProject")}
        </Button>
      </div>

      {/* New project form */}
      {creating && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("subjectPlaceholder")}
            rows={2}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("audiencePlaceholder")}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={langHe} onChange={(e) => setLangHe(e.target.checked)} /> {t("hebrew")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={langEn} onChange={(e) => setLangEn(e.target.checked)} /> {t("english")}
            </label>
            <label className="flex items-center gap-1.5">
              {t("optionCount")}
              <input
                type="number"
                min={1}
                max={8}
                className="w-16 rounded-md border border-border bg-background px-2 py-1"
                value={optionCount}
                onChange={(e) => setOptionCount(Number(e.target.value))}
              />
            </label>
          </div>
          <Button onClick={createProject} disabled={busy}>
            {t("create")}
          </Button>
        </div>
      )}

      {/* Selected project */}
      {detail && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{detail.project.name}</h2>
              <p className="text-sm text-muted-foreground">{detail.project.subject}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {isConversation && detail.project.status === "generating"
                  ? t("statusActiveConversation")
                  : t(`status.${detail.project.status}`)}
              </span>
              {/* Primary: open/continue the interactive conversation */}
              <Button onClick={openConversation} disabled={busy}>
                {hasThread ? t("continueConversation") : t("openConversation")}
              </Button>
              {/* Secondary: auto-generate N options in one run */}
              {detail.project.status !== "generating" && (
                <Button variant="outline" onClick={generateAuto} disabled={busy}>
                  {options.length ? t("regenerateAuto") : t("generateAuto")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={toggleLinking}>
                {t("linkExisting")}
              </Button>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {isConversation ? t("conversationHint") : t("generatingHint")}
          </p>

          {/* Link an existing conversation (option A) */}
          {linking && (
            <div className="space-y-2 rounded-lg border border-border p-4">
              <h3 className="text-sm font-semibold">{t("linkExistingTitle")}</h3>
              {threads === null ? (
                <p className="text-xs text-muted-foreground">{t("loading")}</p>
              ) : threads.length === 0 ? (
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder={t("threadIdPlaceholder")}
                  value={linkThreadId}
                  onChange={(e) => setLinkThreadId(e.target.value.trim())}
                />
              ) : (
                <select
                  className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                  value={linkThreadId}
                  onChange={(e) => setLinkThreadId(e.target.value)}
                >
                  <option value="">{t("pickThread")}</option>
                  {threads.map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.title?.trim() || th.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
              <Button size="sm" onClick={linkThread} disabled={busy || !linkThreadId}>
                {t("linkAndOpen")}
              </Button>
            </div>
          )}

          {/* Gallery */}
          {options.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {options.map((o) => (
                <div key={o.id} className="overflow-hidden rounded-lg border border-border">
                  {o.image_signed_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={o.image_signed_url} alt={o.title ?? o.anchor ?? "option"} className="w-full" />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-muted text-xs text-muted-foreground">
                      {t("noRender")}
                    </div>
                  )}
                  <div className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{o.title ?? o.anchor ?? "—"}</span>
                      {o.is_combined && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t("combined")}</span>
                      )}
                    </div>
                    {o.anchor && <p className="text-xs text-muted-foreground">{o.anchor}</p>}
                    <Button
                      variant={o.is_locked ? "default" : "outline"}
                      size="sm"
                      onClick={() => lockOption(o.id)}
                    >
                      {o.is_locked ? t("locked") : t("chooseThis")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Remix: pick each dimension from an option */}
          {options.length > 1 && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="text-sm font-semibold">{t("remixTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("remixHint")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center justify-between gap-2 text-sm">
                    <span>{t(`dimension.${d}`)}</span>
                    <select
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                      value={picks[d] ?? ""}
                      onChange={(e) => setPicks((prev) => ({ ...prev, [d]: e.target.value || undefined }))}
                    >
                      <option value="">{t("designersChoice")}</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title ?? o.anchor ?? o.id.slice(0, 6)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <Button onClick={remix} disabled={busy}>
                {t("buildCombined")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
