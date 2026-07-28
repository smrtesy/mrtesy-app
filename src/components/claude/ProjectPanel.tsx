"use client";

/**
 * The project panel — one dialog behind one icon (compact-UI convention).
 *
 * A "project" is a plan chat with children: this panel is where the user breaks the
 * plan into parts, opens a part by hand, jumps between the parts and back to the plan,
 * and reads/writes the ONE shared board every part can see.
 *
 * The board is read by a part ON DEMAND only (the user's design choice): the switch
 * here arms "attach the board to my next message", it is never sent automatically.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ClipboardList, CornerUpLeft, FolderPlus, ListTree, Loader2, Pencil, Split } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/common/Markdown";
import { api } from "@/lib/api/client";
import type { ProposedPart } from "./DecomposeReview";

interface LinkThread {
  id: string;
  title: string;
}

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

export function ProjectPanel({
  threadId,
  parent,
  childThreads,
  open,
  onClose,
  locale,
  onOpenThread,
  onDecomposeProposed,
  onChildCreated,
  attachBoard,
  setAttachBoard,
}: {
  threadId: string;
  parent: LinkThread | null;
  childThreads: LinkThread[];
  open: boolean;
  onClose: () => void;
  locale: string;
  /** Open another thread (a part, or the parent plan). */
  onOpenThread: (id: string) => void;
  /** A decompose analysis came back with parts — hand it up so the review opens. */
  onDecomposeProposed: (analysis: { id: string; parts: ProposedPart[] }) => void;
  /** A manual child was created — refresh the rail / children list. */
  onChildCreated: () => void;
  /** Whether the next message will carry the board (armed here, sent by the chat). */
  attachBoard: boolean;
  setAttachBoard: (v: boolean) => void;
}) {
  const t = useTranslations("claudeChat.project");

  const [analyzing, setAnalyzing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // Board state
  const [board, setBoard] = useState("");
  const [savedBoard, setSavedBoard] = useState("");
  const [boardUpdatedAt, setBoardUpdatedAt] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState(true);
  const [boardEditing, setBoardEditing] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    try {
      const r = await api<{ body: string; updated_at: string | null }>(
        `/api/claude/threads/${threadId}/board`,
      );
      setBoard(r.body ?? "");
      setSavedBoard(r.body ?? "");
      setBoardUpdatedAt(r.updated_at);
    } catch {
      // A thread with no project still has a (self) board endpoint; a failure just
      // leaves the board empty rather than blocking the panel.
    } finally {
      setBoardLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (open) void loadBoard();
  }, [open, loadBoard]);

  async function decompose() {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      const r = await api<{ analysis: { id: string; proposal: { parts: ProposedPart[] } } | null }>(
        `/api/claude/threads/${threadId}/analyze-decompose`,
        { method: "POST" },
      );
      if (r.analysis) {
        onDecomposeProposed({ id: r.analysis.id, parts: r.analysis.proposal.parts ?? [] });
      } else {
        toast.message(t("decomposeNone"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function addChild() {
    if (creating) return;
    setCreating(true);
    try {
      await api(`/api/claude/threads/${threadId}/children`, {
        method: "POST",
        body: { title: newTitle.trim() },
      });
      setNewTitle("");
      onChildCreated();
      toast.success(t("childCreated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function saveBoard() {
    setBoardSaving(true);
    try {
      const r = await api<{ body: string; updated_at: string }>(`/api/claude/threads/${threadId}/board`, {
        method: "PUT",
        body: { body: board },
      });
      setSavedBoard(r.body ?? "");
      setBoardUpdatedAt(r.updated_at);
      setBoardEditing(false);
      toast.success(t("boardSaved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBoardSaving(false);
    }
  }

  async function summarizeToBoard() {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const r = await api<{ body: string; updated_at: string }>(
        `/api/claude/threads/${threadId}/board/summarize`,
        { method: "POST" },
      );
      setBoard(r.body ?? "");
      setSavedBoard(r.body ?? "");
      setBoardUpdatedAt(r.updated_at);
      toast.success(t("summarized"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSummarizing(false);
    }
  }

  const boardDirty = board !== savedBoard;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTree className="size-4" />
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-1">
          {/* Back to the plan, when this chat is a part. */}
          {parent && (
            <button
              type="button"
              onClick={() => onOpenThread(parent.id)}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-start text-xs transition hover:bg-muted"
            >
              <CornerUpLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {t("backToPlan", { title: parent.title?.trim() || "" })}
              </span>
            </button>
          )}

          {/* Parts (children). */}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t("partsTitle")}</p>
            {childThreads.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noParts")}</p>
            ) : (
              <div className="space-y-1">
                {childThreads.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onOpenThread(c.id)}
                    className="flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-start text-xs transition hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {c.title?.trim() || t("untitledPart")}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Two ways to make parts: let Claude propose, or add one by hand. */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void decompose()} disabled={analyzing}>
                {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Split className="size-3.5" />}
                {t("decompose")}
              </Button>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) void addChild();
                }}
                placeholder={t("newChildPlaceholder")}
                dir="auto"
                className="h-8 flex-1 text-xs"
              />
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void addChild()} disabled={creating}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
                {t("addChild")}
              </Button>
            </div>
          </div>

          {/* The shared board. */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ClipboardList className="size-4" />
                {t("boardTitle")}
              </p>
              {!boardLoading && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => setBoardEditing((v) => !v)}
                >
                  <Pencil className="size-3.5" />
                  {boardEditing ? t("boardPreview") : t("boardEdit")}
                </Button>
              )}
            </div>

            {boardLoading ? (
              <p className="text-xs text-muted-foreground">…</p>
            ) : boardEditing ? (
              <Textarea
                value={board}
                onChange={(e) => setBoard(e.target.value)}
                rows={10}
                dir="auto"
                className="font-mono text-xs"
                placeholder={t("boardPlaceholder")}
              />
            ) : board.trim() ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border bg-card p-3">
                <Markdown density="chat">{board}</Markdown>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("boardEmpty")}</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {boardEditing && (
                <Button size="sm" className="h-8" onClick={() => void saveBoard()} disabled={boardSaving || !boardDirty}>
                  {boardSaving && <Loader2 className="me-1 size-4 animate-spin" />}
                  {t("boardSave")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => void summarizeToBoard()}
                disabled={summarizing}
              >
                {summarizing ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardList className="size-3.5" />}
                {t("summarize")}
              </Button>
              {boardUpdatedAt && (
                <span className="text-[11px] text-muted-foreground">
                  {t("boardUpdatedAt", { when: fmtWhen(boardUpdatedAt, locale) })}
                </span>
              )}
            </div>

            {/* On-demand read: arm the board onto the next message. Never automatic. */}
            <label className="flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="min-w-0 flex-1 text-xs" dir="auto">
                {t("attachBoard")}
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("attachBoardHint")}</span>
              </span>
              <Switch checked={attachBoard} onCheckedChange={setAttachBoard} aria-label={t("attachBoard")} />
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
