"use client";

/**
 * שיטות עבודה — the working-method list on the Claude screen.
 *
 * A plain list, one row per method: the TYPE is the row's headline ("מחקר"), and
 * under it, small, the method's name as a link straight to the document that
 * defines it plus that document's last-updated date. Picking a row is what makes
 * the next run follow that method — the backend prepends the method's instructions
 * to the prompt, so choosing "מחקר" really does mean "work by the research plan we
 * built", not just a label on the run.
 *
 * The method's canonical text stays the repo document the link opens; what is
 * edited here is the operative instruction body sent with the run. That body
 * is markdown, so it gets the same two views as the standing instructions:
 * edit it as the rendered document, or drop to the source.
 *
 * Dates render in America/New_York (CLAUDE.md), never in local or raw UTC.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Code2, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Trash2, Download } from "lucide-react";
import { toast } from "sonner";

import { LazyMarkdownEditor } from "@/components/common/LazyMarkdownEditor";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

export interface Playbook {
  id: string;
  kind: string;
  name: string;
  doc_url: string | null;
  doc_path: string | null;
  repo: string | null;
  instructions: string | null;
  source: "db" | "repo";
  is_active: boolean;
  sort_order: number;
  doc_updated_at: string | null;
  updated_at: string;
}

/** Must match the CHECK on claude_playbooks.kind — a value the DB rejects would
 *  fail on save rather than on pick. */
const KINDS = ["research", "planning", "build", "review", "content", "other"] as const;

/** New York, per CLAUDE.md: every date the user reads is US Eastern. */
function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale === "he" ? "he-IL" : "en-US", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

type Draft = {
  id: string | null;
  kind: string;
  name: string;
  doc_url: string;
  instructions: string;
};

const EMPTY: Draft = { id: null, kind: "research", name: "", doc_url: "", instructions: "" };

export function PlaybookList({
  locale,
  selectedId,
  onSelect,
}: {
  locale: string;
  /** The method the next run will follow, or null for none. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const t = useTranslations("claudeRuns.playbooks");
  const [items, setItems] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  /**
   * Which view the body is edited in. Reset whenever the dialog opens on a
   * different method, so the choice does not leak between playbooks — and so
   * the rich editor is what greets you, the same as everywhere else.
   */
  const [codeView, setCodeView] = useState(false);
  /**
   * The draft as it was opened, so closing can tell "nothing typed" from
   * "about to lose a body someone just wrote". A ref, not state: it is only
   * ever read at close time and must not trigger a render.
   */
  const opened = useRef<Draft | null>(null);

  /** Open the editor on a draft, recording what it looked like. */
  const openDraft = useCallback((next: Draft) => {
    opened.current = next;
    setCodeView(false);
    setDraft(next);
  }, []);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { playbooks } = await api<{ playbooks: Playbook[] }>("/api/claude/playbooks");
      setItems(playbooks ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function seed() {
    setWorking(true);
    try {
      const { inserted } = await api<{ inserted: number }>("/api/claude/playbooks/seed", {
        method: "POST",
      });
      toast.success(inserted > 0 ? t("seeded", { count: inserted }) : t("seededNone"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function refreshDates() {
    setWorking(true);
    try {
      const { updated, failures } = await api<{ updated: number; failures: string[] }>(
        "/api/claude/playbooks/refresh",
        { method: "POST" },
      );
      // Partial success is reported as partial: silently showing "refreshed" while
      // half the rows kept a stale date is exactly the kind of quiet lie to avoid.
      if (failures.length > 0) toast.warning(t("refreshedPartial", { count: updated }));
      else toast.success(t("refreshed", { count: updated }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  /**
   * Escape means "get me out of this text box" before it means "close the
   * dialog". Inside the rich editor a keyboard user has no other exit —
   * ProseMirror binds Tab itself inside lists and tables — so the first
   * Escape blurs back to the dialog (Tab works again from there) and only
   * the next one closes. Radix listens for Escape in the CAPTURE phase, so
   * this has to hang off its own hook; stopPropagation from inside the
   * editor is already too late.
   */
  function escapeLeavesEditorFirst(e: KeyboardEvent) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".ProseMirror")) {
      focused.blur();
      e.preventDefault();
    }
  }

  /**
   * Every way out of the dialog funnels through here — Escape, the X, and
   * Cancel all land on `onOpenChange(false)`. `open` is ours, so simply not
   * clearing the draft keeps the dialog up.
   */
  function requestClose() {
    const before = opened.current;
    const changed =
      !!draft &&
      !!before &&
      (draft.kind !== before.kind ||
        draft.name !== before.name ||
        draft.doc_url !== before.doc_url ||
        draft.instructions !== before.instructions);
    if (changed && !window.confirm(t("confirmDiscard"))) return;
    setDraft(null);
  }

  async function save() {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    try {
      const body = {
        kind: draft.kind,
        name: draft.name.trim(),
        doc_url: draft.doc_url.trim() || null,
        instructions: draft.instructions,
      };
      if (draft.id) await api(`/api/claude/playbooks/${draft.id}`, { method: "PATCH", body });
      else await api("/api/claude/playbooks", { method: "POST", body });
      toast.success(t("saved"));
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: Playbook) {
    if (!window.confirm(t("confirmDelete", { name: p.name }))) return;
    try {
      await api(`/api/claude/playbooks/${p.id}`, { method: "DELETE" });
      if (selectedId === p.id) onSelect(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={refreshDates}
            disabled={working}
            aria-label={t("refresh")}
            title={t("refresh")}
          >
            {working ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={seed}
            disabled={working}
            aria-label={t("seed")}
            title={t("seed")}
          >
            <Download className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openDraft({ ...EMPTY })}
            aria-label={t("add")}
            title={t("add")}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
      ) : (
        <ul className="grid">
          {items.map((p) => {
            const active = selectedId === p.id;
            return (
              <li
                key={p.id}
                className={cn(
                  "flex items-start gap-2 border-b border-dashed py-2 last:border-b-0",
                  !p.is_active && "opacity-50",
                )}
              >
                {/* The row itself is the selector; the name is a separate link so
                    opening the document never changes the selection. */}
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : p.id)}
                  aria-pressed={active}
                  className="min-w-0 flex-1 text-start"
                >
                  <span
                    className={cn(
                      "block text-[13px] font-semibold",
                      active ? "text-primary" : undefined,
                    )}
                  >
                    {t(`kind.${p.kind}`)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {p.name}
                    {p.doc_updated_at ? ` · ${fmtDate(p.doc_updated_at, locale)}` : ""}
                  </span>
                </button>

                {p.doc_url && (
                  <a
                    href={p.doc_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("openDoc")}
                    title={p.doc_url}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() =>
                    openDraft({
                      id: p.id,
                      kind: p.kind,
                      name: p.name,
                      doc_url: p.doc_url ?? "",
                      instructions: p.instructions ?? "",
                    })
                  }
                  aria-label={t("edit")}
                  title={t("edit")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(p)}
                  aria-label={t("delete")}
                  title={t("delete")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && requestClose()}>
        {/* Outside clicks never dismiss: this dialog can hold a long body,
            and a stray click beside it must not be able to bin the lot. */}
        <DialogContent
          className="max-w-2xl"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={escapeLeavesEditorFirst}
        >
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("editTitle") : t("addTitle")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-2">
              <Select value={draft.kind} onValueChange={(v) => setDraft((d) => (d ? { ...d, kind: v } : d))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`kind.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                placeholder={t("namePlaceholder")}
              />
              <Input
                dir="ltr"
                value={draft.doc_url}
                onChange={(e) => setDraft((d) => (d ? { ...d, doc_url: e.target.value } : d))}
                placeholder={t("docUrlPlaceholder")}
              />
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="pb-instructions" className="text-xs font-medium text-muted-foreground">
                  {t("instructionsLabel")}
                </label>
                <IconButton
                  label={codeView ? t("richView") : t("codeView")}
                  color="primary"
                  onClick={() => setCodeView((v) => !v)}
                >
                  {codeView ? <Pencil className="size-4" /> : <Code2 className="size-4" />}
                </IconButton>
              </div>
              {codeView ? (
                /* dir=ltr on purpose: source reads like source only when the
                   markers (`#`, `-`, `|`) stay in the left gutter. */
                <Textarea
                  id="pb-instructions"
                  dir="ltr"
                  value={draft.instructions}
                  onChange={(e) => setDraft((d) => (d ? { ...d, instructions: e.target.value } : d))}
                  placeholder={t("instructionsPlaceholder")}
                  rows={12}
                  className="font-mono text-xs"
                />
              ) : (
                <div className="max-h-[50vh] overflow-y-auto rounded-lg border bg-card p-3 focus-within:ring-1 focus-within:ring-ring">
                  {/* Functional update: the editor holds its own onChange for the
                      life of the document, so closing over `draft` here would
                      write every edit on top of a stale name/url. */}
                  <LazyMarkdownEditor
                    value={draft.instructions}
                    onChange={(md) => setDraft((d) => (d ? { ...d, instructions: md } : d))}
                    placeholder={t("instructionsPlaceholder")}
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{t("instructionsHint")}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={requestClose}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving || !draft?.name.trim()}>
              {saving && <Loader2 className="me-1 size-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
