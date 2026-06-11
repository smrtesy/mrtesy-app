"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Plus, X, Sparkles, GripVertical, ArrowUpRight, Pencil, Check, Copy } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ChecklistItem } from "@/types/task";

interface TaskChecklistProps {
  taskId: string;
  items: ChecklistItem[];
  onChange: () => void;
  /** Text direction — Hebrew-first product, so RTL unless told otherwise. */
  dir?: "rtl" | "ltr";
}

export function TaskChecklist({ taskId, items, onChange, dir = "rtl" }: TaskChecklistProps) {
  const t = useTranslations("tasks.checklist");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const [saving, setSaving] = useState(false);
  // Mirror the prop locally so rapid toggles on DIFFERENT items don't race
  // against a not-yet-arrived parent refetch (which would re-read stale `items`).
  const [localItems, setLocalItems] = useState<ChecklistItem[]>(items);
  useEffect(() => { setLocalItems(items); }, [items]);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  // Serializes whole-array PATCHes: two rapid optimistic adds must apply in
  // order, otherwise the earlier (shorter) array can land last and silently
  // drop the newer item.
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());

  // Native HTML5 drag-and-drop. Records the index of the row being dragged so
  // we can compute the new order on drop. dragOverIdx is used for the highlight.
  const dragFromIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const total = localItems.length;
  const done = localItems.filter((it) => it.done).length;

  async function persist(next: ChecklistItem[]) {
    setLocalItems(next);
    setSaving(true);
    try {
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { checklist: next },
      });
      onChange();
    } catch (e) {
      // Roll back optimistic update on failure.
      setLocalItems(items);
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  function handleAdd() {
    const title = draft.trim();
    if (!title) return;
    const now = new Date().toISOString();
    const newItem: ChecklistItem = {
      id: crypto.randomUUID(),
      title,
      done: false,
      created_at: now,
      completed_at: null,
      created_by: "user",
    };
    // Optimistic: the row appears and the input is ready for the NEXT item
    // immediately — the save runs in the background (persist rolls back on
    // failure). No await: awaiting here was the Enter-lag the user felt.
    // Chained so rapid adds can't apply out of order server-side.
    setDraft("");
    const next = [...localItems, newItem];
    setLocalItems(next);
    persistChainRef.current = persistChainRef.current.then(() => persist(next));
    setAdding(true);
    requestAnimationFrame(() => addInputRef.current?.focus());
  }

  function openAdd() {
    setAdding(true);
    requestAnimationFrame(() => addInputRef.current?.focus());
  }

  /** Copy the whole checklist as plain text (e.g. to paste into an AI fix). */
  async function handleCopyAll() {
    const text = localItems
      .map((it) => `- [${it.done ? "x" : " "}] ${it.title}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  async function handleToggle(id: string) {
    const now = new Date().toISOString();
    const next = localItems.map((it) =>
      it.id === id
        ? { ...it, done: !it.done, completed_at: !it.done ? now : null }
        : it,
    );
    await persist(next);
  }

  async function handleRemove(id: string) {
    const next = localItems.filter((it) => it.id !== id);
    await persist(next);
  }

  function handleStartEdit(item: ChecklistItem) {
    setEditingId(item.id);
    setEditingDraft(item.title);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditingDraft("");
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    const title = editingDraft.trim();
    if (!title) {
      handleCancelEdit();
      return;
    }
    const next = localItems.map((it) =>
      it.id === editingId ? { ...it, title } : it,
    );
    setEditingId(null);
    setEditingDraft("");
    await persist(next);
  }

  async function handlePromote(item: ChecklistItem) {
    // Order matters: create the new task FIRST, then remove from checklist.
    // If POST fails we abort cleanly (no data change). If POST succeeds but
    // the PATCH to remove fails, the item is duplicated (visible in both
    // places) — annoying but no data loss. Reversing the order would risk
    // losing the item entirely if POST fails after the PATCH succeeded.
    setSaving(true);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: {
          title: item.title,
          title_he: item.title,
          priority: "medium",
          status: "inbox",
        },
      });
      const next = localItems.filter((it) => it.id !== item.id);
      await persist(next);
      toast.success(t("promotedToast"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  function handleDragStart(idx: number) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      dragFromIdx.current = idx;
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires non-empty data to start a drag.
      e.dataTransfer.setData("text/plain", String(idx));
    };
  }

  function handleDragOver(idx: number) {
    return (e: React.DragEvent<HTMLDivElement>) => {
      if (dragFromIdx.current === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOverIdx !== idx) setDragOverIdx(idx);
    };
  }

  function handleDragLeave() {
    setDragOverIdx(null);
  }

  async function handleDrop(idx: number) {
    const from = dragFromIdx.current;
    dragFromIdx.current = null;
    setDragOverIdx(null);
    if (from === null || from === idx) return;
    const next = [...localItems];
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    await persist(next);
  }

  function handleDragEnd() {
    dragFromIdx.current = null;
    setDragOverIdx(null);
  }

  return (
    <div dir={dir}>
      <h4 className="text-xs font-medium mb-1.5 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
        <span>{t("title")}</span>
        <IconButton
          label={t("addButton")}
          color="primary"
          className="h-6 w-6 min-h-0 min-w-0 [&_svg]:size-3.5"
          onClick={openAdd}
        >
          <Plus />
        </IconButton>
        {total > 0 && (
          <IconButton
            label={t("copy")}
            color="neutral"
            className="h-6 w-6 min-h-0 min-w-0 [&_svg]:size-3.5"
            onClick={handleCopyAll}
          >
            <Copy />
          </IconButton>
        )}
        {total > 0 && (
          <span className="ms-auto text-[11px] font-normal normal-case">
            {t("progress", { done, total })}
          </span>
        )}
      </h4>

      <div className="space-y-1">
        {localItems.map((item, idx) => {
          const isEditing = editingId === item.id;
          return (
            <div
              key={item.id}
              draggable={!isEditing && !saving}
              onDragStart={handleDragStart(idx)}
              onDragOver={handleDragOver(idx)}
              onDragLeave={handleDragLeave}
              onDrop={() => handleDrop(idx)}
              onDragEnd={handleDragEnd}
              className={cn(
                "flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-sm group bg-background",
                dragOverIdx === idx && "border-primary ring-1 ring-primary/40",
              )}
            >
              <GripVertical
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground/40",
                  !isEditing && "cursor-grab active:cursor-grabbing",
                )}
                aria-hidden
              />
              <input
                type="checkbox"
                checked={item.done}
                disabled={saving || isEditing}
                onChange={() => handleToggle(item.id)}
                className="h-4 w-4 cursor-pointer shrink-0"
              />

              {isEditing ? (
                <Input
                  value={editingDraft}
                  onChange={(e) => setEditingDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleSaveEdit(); }
                    if (e.key === "Escape") { e.preventDefault(); handleCancelEdit(); }
                  }}
                  onBlur={handleSaveEdit}
                  autoFocus
                  dir="auto"
                  className="flex-1 h-7 text-sm"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => handleStartEdit(item)}
                  dir="auto"
                  className={cn(
                    "flex-1 break-words text-start cursor-text",
                    item.done && "line-through text-muted-foreground",
                  )}
                >
                  {item.title}
                </button>
              )}

              {item.created_by === "ai" && !isEditing && (
                <span
                  title={t("aiBadge")}
                  className="shrink-0 inline-flex items-center text-[10px] text-muted-foreground"
                >
                  <Sparkles className="h-3 w-3" />
                </span>
              )}

              {isEditing ? (
                <IconButton
                  label={t("saveEdit")}
                  color="green"
                  className="h-6 w-6 min-h-0 min-w-0 shrink-0"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleSaveEdit}
                >
                  <Check />
                </IconButton>
              ) : (
                <>
                  <IconButton
                    label={t("editItem")}
                    color="primary"
                    disabled={saving}
                    onClick={() => handleStartEdit(item)}
                    className="h-6 w-6 min-h-0 min-w-0 opacity-0 group-hover:opacity-100 transition shrink-0"
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label={t("promoteItem")}
                    color="primary"
                    disabled={saving}
                    onClick={() => handlePromote(item)}
                    className="h-6 w-6 min-h-0 min-w-0 opacity-0 group-hover:opacity-100 transition shrink-0"
                  >
                    <ArrowUpRight />
                  </IconButton>
                  <IconButton
                    label={t("removeItem")}
                    color="red"
                    disabled={saving}
                    onClick={() => handleRemove(item.id)}
                    className="h-6 w-6 min-h-0 min-w-0 opacity-0 group-hover:opacity-100 transition shrink-0"
                  >
                    <X />
                  </IconButton>
                </>
              )}
            </div>
          );
        })}

        {/* Add row — revealed by either + (heading or bottom). Enter saves
            instantly and keeps the row open for the next item; empty Enter /
            Escape / blur closes it. NOT disabled while saving — typing the
            next item must never wait for the previous save. dir comes from
            the prop so the empty placeholder is right-aligned in Hebrew. */}
        {adding && (
          <Input
            ref={addInputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.trim()) handleAdd();
                else setAdding(false);
              }
              if (e.key === "Escape") { e.preventDefault(); setDraft(""); setAdding(false); }
            }}
            onBlur={() => { if (!draft.trim()) setAdding(false); }}
            placeholder={t("addPlaceholder")}
            dir={dir}
            className="h-8 text-sm"
          />
        )}

        {/* Bottom + — same add flow, handy on long lists. */}
        {!adding && total > 0 && (
          <button
            type="button"
            onClick={openAdd}
            className="flex w-full items-center gap-1.5 rounded border border-dashed px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addButton")}
          </button>
        )}
      </div>
    </div>
  );
}
