"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, X, Sparkles } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ChecklistItem } from "@/types/task";

interface TaskChecklistProps {
  taskId: string;
  items: ChecklistItem[];
  onChange: () => void;
}

export function TaskChecklist({ taskId, items, onChange }: TaskChecklistProps) {
  const t = useTranslations("tasks.checklist");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Mirror the prop locally so rapid toggles on DIFFERENT items don't race
  // against a not-yet-arrived parent refetch (which would re-read stale `items`).
  const [localItems, setLocalItems] = useState<ChecklistItem[]>(items);
  useEffect(() => { setLocalItems(items); }, [items]);

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

  async function handleAdd() {
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
    setDraft("");
    await persist([...localItems, newItem]);
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

  return (
    <div>
      <h4 className="text-sm font-medium mb-2 flex items-center justify-between">
        <span>{t("title")}</span>
        {total > 0 && (
          <span className="text-xs text-muted-foreground font-normal">
            {t("progress", { done, total })}
          </span>
        )}
      </h4>

      <div className="space-y-1.5">
        {localItems.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm group"
          >
            <input
              type="checkbox"
              checked={item.done}
              disabled={saving}
              onChange={() => handleToggle(item.id)}
              className="h-4 w-4 cursor-pointer shrink-0"
            />
            <span
              dir="auto"
              className={cn(
                "flex-1 break-words",
                item.done && "line-through text-muted-foreground",
              )}
            >
              {item.title}
            </span>
            {item.created_by === "ai" && (
              <span
                title={t("aiBadge")}
                className="shrink-0 inline-flex items-center text-[10px] text-purple-600"
              >
                <Sparkles className="h-3 w-3" />
              </span>
            )}
            <button
              type="button"
              aria-label={t("removeItem")}
              disabled={saving}
              onClick={() => handleRemove(item.id)}
              className="opacity-0 group-hover:opacity-100 transition text-muted-foreground hover:text-destructive shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        <div className="flex gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder={t("addPlaceholder")}
            dir="auto"
            className="h-8 text-sm"
            disabled={saving}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 gap-1 shrink-0"
            onClick={handleAdd}
            disabled={saving || !draft.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}
