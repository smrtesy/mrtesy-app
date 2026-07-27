"use client";

/**
 * הוראות קבועות — the standing-instructions document, edited in place.
 *
 * One document per org, prepended by the backend to EVERY run, so it is the thing
 * that makes a run behave like a session that already knows how we work (language,
 * timezone, cost approval, deep links) instead of starting cold.
 *
 * The repo copy at docs/claude-console/standing-instructions.md is the readable
 * reference; THIS is the live copy the runs actually get. Both are linked from the
 * screen so they never silently diverge without the user seeing both.
 *
 * Compact-UI convention: collapsed behind one icon button, expands on demand.
 */

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Code2, ExternalLink, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api/client";

/**
 * The rich editor drags in ProseMirror (~110 kB) and this panel is collapsed
 * by default, so it must not sit in the runs screen's first load. It also
 * needs a DOM to construct, hence no SSR.
 */
const MarkdownEditor = dynamic(
  () => import("@/components/common/MarkdownEditor").then((m) => m.MarkdownEditor),
  {
    ssr: false,
    loading: () => <p className="text-xs text-muted-foreground">…</p>,
  },
);

const REPO_DOC_URL =
  "https://github.com/smrtesy/mrtesy-app/blob/main/docs/claude-console/standing-instructions.md";

/** New York, per CLAUDE.md. */
function fmtWhen(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale === "he" ? "he-IL" : "en-US", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function StandingInstructions({ locale }: { locale: string }) {
  const t = useTranslations("claudeRuns.instructions");
  const [body, setBody] = useState("");
  /** What is currently stored, so "unsaved changes" is a fact rather than a guess. */
  const [saved, setSaved] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * Two views, both editable, one toggle:
   *   false → the document as it reads (headings, tables, links) — and you
   *           type straight into it. This is the default.
   *   true  → the markdown source, for when the formatting itself is the
   *           thing being fixed.
   * Compact-UI convention: the second view hides behind one quiet icon.
   */
  const [codeView, setCodeView] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ body: string; updated_at: string | null }>("/api/claude/instructions");
      setBody(r.body ?? "");
      setSaved(r.body ?? "");
      setUpdatedAt(r.updated_at);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const r = await api<{ body: string; updated_at: string }>("/api/claude/instructions", {
        method: "PUT",
        body: { body },
      });
      setSaved(r.body ?? "");
      setUpdatedAt(r.updated_at);
      toast.success(t("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = body !== saved;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <div className="flex items-center gap-1">
          <a
            href={REPO_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
            {t("repoCopy")}
          </a>
          {!loading && (
            <IconButton
              label={codeView ? t("richView") : t("codeView")}
              color="primary"
              onClick={() => setCodeView((v) => !v)}
            >
              {codeView ? <Pencil className="size-4" /> : <Code2 className="size-4" />}
            </IconButton>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">…</p>
      ) : (
        <>
          {codeView ? (
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("placeholder")}
              rows={16}
              className="font-mono text-xs"
              dir="ltr"
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-card p-4 focus-within:ring-1 focus-within:ring-ring">
              {/* Uncontrolled by design — it reads `body` once and then owns
                  the document. Toggling to the code view unmounts it, so
                  coming back re-seeds it with whatever the source edit left. */}
              <MarkdownEditor value={body} onChange={setBody} placeholder={t("placeholder")} />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {updatedAt ? t("updatedAt", { when: fmtWhen(updatedAt, locale) }) : t("never")}
            </p>
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              {saving && <Loader2 className="me-1 size-4 animate-spin" />}
              {dirty ? t("save") : t("noChanges")}
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{t("hint")}</p>
        </>
      )}
    </div>
  );
}
