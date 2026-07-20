"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Play, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api/client";
import { useDayTool, useDayTools } from "@/hooks/useDayTools";
import type { DailyReportItem } from "@/types/daily-report";

/** Local editor item — carries a stable client-only key for drag-and-drop
 *  (new items have no server id yet, so we can't sort on that). */
type EditorItem = DailyReportItem & { _key: string };

/**
 * The daily-report tool's config editor (revealed under its toggle in
 * DayToolsSettings). Lets the user define report questions + per-answer scores,
 * reorder them by dragging, pick the period + delivery hour, and generate a
 * report on demand. Compact by default (docs/day-tools-plan.md UI principle).
 */
export function DailyReportSettings() {
  const t = useTranslations("dailyReport");
  const { config } = useDayTool("dailyreport");
  const { setToolConfig } = useDayTools();

  const [items, setItems] = useState<EditorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Stable keys for the sortable list (independent of server ids).
  const keySeq = useRef(0);
  const nextKey = () => `k${keySeq.current++}`;

  const period = typeof config.period === "string" ? config.period : "weekly";
  const reportHour = typeof config.report_hour === "number" ? config.report_hour : 8;

  useEffect(() => {
    let alive = true;
    api<{ items: DailyReportItem[] }>("/api/daily-report/config")
      .then((res) => {
        if (alive) setItems((res.items ?? []).map((it) => ({ ...it, _key: nextKey() })));
      })
      .catch(() => {
        if (alive) toast.error(t("loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((it) => it._key === active.id);
      const newIndex = prev.findIndex((it) => it._key === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  // ── item/option editing (local state until Save) ──────────────────────────
  const addItem = () =>
    setItems((prev) => [...prev, { _key: nextKey(), label: "", options: [{ label: "", score: null }] }]);
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const setItemLabel = (i: number, label: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, label } : it)));

  const addOption = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, options: [...it.options, { label: "", score: null }] } : it)),
    );
  const removeOption = (i: number, j: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, options: it.options.filter((_, oIdx) => oIdx !== j) } : it,
      ),
    );
  const setOptionLabel = (i: number, j: number, label: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, options: it.options.map((o, oIdx) => (oIdx === j ? { ...o, label } : o)) }
          : it,
      ),
    );
  const setOptionScore = (i: number, j: number, raw: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? {
              ...it,
              options: it.options.map((o, oIdx) =>
                oIdx === j ? { ...o, score: raw.trim() === "" ? null : Number(raw) } : o,
              ),
            }
          : it,
      ),
    );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      // Array order = display order → the server derives `position` from it.
      const payload = {
        items: items
          .map((it) => ({
            id: it.id,
            label: it.label.trim(),
            options: it.options
              .map((o) => ({ id: o.id, label: o.label.trim(), score: o.score }))
              .filter((o) => o.label),
          }))
          .filter((it) => it.label),
      };
      await api("/api/daily-report/config", { method: "PUT", body: payload });
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [items, t]);

  const generateNow = useCallback(async () => {
    setGenerating(true);
    try {
      await api("/api/daily-report/generate", { method: "POST", body: { period } });
      toast.success(t("generatedToInbox"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("generateError"));
    } finally {
      setGenerating(false);
    }
  }, [period, t]);

  const saveToolConfig = (patch: Record<string, unknown>) =>
    setToolConfig("dailyreport", patch).catch(() => toast.error(t("saveError")));

  if (loading) {
    return (
      <div className="ms-1 flex items-center gap-2 border-s ps-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div className="ms-1 space-y-4 border-s ps-3">
      {/* Questions — draggable to reorder */}
      <div className="space-y-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((it) => it._key)} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {items.map((item, i) => (
                <SortableQuestion key={item._key} id={item._key} dragLabel={t("reorder")}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={item.label}
                      placeholder={t("questionPlaceholder")}
                      dir="auto"
                      className="h-8 text-sm"
                      onChange={(e) => setItemLabel(i, e.target.value)}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0 text-muted-foreground"
                      aria-label={t("removeQuestion")}
                      onClick={() => removeItem(i)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="space-y-1.5 ps-2">
                    {item.options.map((opt, j) => (
                      <div key={opt.id ?? `new-${j}`} className="flex items-center gap-2">
                        <Input
                          value={opt.label}
                          placeholder={t("answerPlaceholder")}
                          dir="auto"
                          className="h-7 flex-1 text-sm"
                          onChange={(e) => setOptionLabel(i, j, e.target.value)}
                        />
                        <Input
                          value={opt.score ?? ""}
                          placeholder={t("scorePlaceholder")}
                          type="number"
                          inputMode="numeric"
                          className="h-7 w-20 text-sm"
                          aria-label={t("scoreLabel")}
                          onChange={(e) => setOptionScore(i, j, e.target.value)}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0 text-muted-foreground"
                          aria-label={t("removeAnswer")}
                          onClick={() => removeOption(i, j)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 text-xs text-muted-foreground"
                      onClick={() => addOption(i)}
                    >
                      <Plus className="h-3.5 w-3.5" /> {t("addAnswer")}
                    </Button>
                  </div>
                </SortableQuestion>
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <Button type="button" size="sm" variant="outline" className="gap-1 text-xs" onClick={addItem}>
          <Plus className="h-3.5 w-3.5" /> {t("addQuestion")}
        </Button>
      </div>

      {/* Period + delivery hour */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("periodLabel")}</span>
          <Select value={period} onValueChange={(v) => saveToolConfig({ period: v })}>
            <SelectTrigger className="h-8 w-32 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">{t("periodWeekly")}</SelectItem>
              <SelectItem value="monthly">{t("periodMonthly")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("hourLabel")}</span>
          <Input
            type="number"
            min={0}
            max={23}
            value={reportHour}
            className="h-8 w-20 text-sm"
            aria-label={t("hourLabel")}
            onChange={(e) => {
              const n = Math.max(0, Math.min(23, Number(e.target.value) || 0));
              saveToolConfig({ report_hour: n });
            }}
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground" dir="auto">
        {period === "monthly" ? t("deliveryNoteMonthly") : t("deliveryNoteWeekly")}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={saving} className="gap-1 text-xs">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("saveQuestions")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={generateNow}
          disabled={generating}
          className="gap-1 text-xs"
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {t("generateNow")}
        </Button>
      </div>
    </div>
  );
}

/** One draggable question card: a grip handle (drag) + the question's editable
 *  content. Mirrors the SortableDeskRow pattern in TaskList. */
function SortableQuestion({ id, dragLabel, children }: { id: string; dragLabel: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-start gap-1 rounded-md border p-2"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="mt-1 shrink-0 touch-none cursor-grab text-muted-foreground/30 hover:text-muted-foreground active:cursor-grabbing"
        aria-label={dragLabel}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}
