"use client";

/**
 * PlanBlock — an editable plan Claude puts on screen as a list of steps.
 *
 * Each row is one step. The user curates the plan in place — delete a row, edit
 * its text, add a row above or at the end, reorder — and then confirms. The
 * confirmed list (the EDITED one, not Claude's original) is sent back as a
 * follow-up turn for Claude to execute step by step. So the user shapes the
 * plan by clicking, not by describing changes in prose.
 *
 * Read-only once a newer turn exists (`interactive={false}`): the edited plan
 * has already been sent, so history shows the steps as a static numbered list.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Plus, Trash2, GripVertical } from "lucide-react";

import type { PlanBlock as PlanBlockData } from "./blocks";

interface Row {
  /** Stable per-row key so React keeps focus/caret while editing a row's text.
   *  A plain index key would remount the input on every insert/delete. */
  key: string;
  text: string;
}

let ROW_SEQ = 0;
function makeRow(text: string): Row {
  ROW_SEQ += 1;
  return { key: `r${ROW_SEQ}`, text };
}

export function PlanBlock({
  block,
  interactive,
  onSubmit,
}: {
  block: PlanBlockData;
  interactive: boolean;
  /** Send the confirmed plan as a follow-up turn. */
  onSubmit: (message: string) => void;
}) {
  const t = useTranslations("claudeChat");
  const [rows, setRows] = useState<Row[]>(() => block.steps.map(makeRow));
  const [confirmed, setConfirmed] = useState(false);

  const disabled = !interactive || confirmed;

  function edit(key: string, text: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, text } : r)));
  }
  function remove(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }
  function insertAfter(index: number) {
    setRows((prev) => {
      const next = prev.slice();
      next.splice(index + 1, 0, makeRow(""));
      return next;
    });
  }
  function addEnd() {
    setRows((prev) => [...prev, makeRow("")]);
  }

  function confirm() {
    if (disabled) return;
    const steps = rows.map((r) => r.text.trim()).filter((s) => s.length > 0);
    if (steps.length === 0) return;
    setConfirmed(true);
    const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    onSubmit(`${t("interactive.planConfirmPreamble")}\n\n${numbered}`);
  }

  // Read-only history: the plan as a plain numbered list, no controls.
  if (!interactive) {
    return (
      <div dir="auto" className="my-3 rounded-xl border bg-muted/20 p-3 opacity-70">
        {block.title && (
          <p className="mb-2 text-sm font-semibold text-foreground">{block.title}</p>
        )}
        <ol className="list-decimal space-y-1 ps-6 text-sm leading-relaxed">
          {block.steps.map((s, i) => (
            <li key={i} dir="auto">
              {s}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const liveSteps = rows.filter((r) => r.text.trim().length > 0).length;

  return (
    <div dir="auto" className="my-3 rounded-xl border bg-muted/20 p-3">
      {block.title && (
        <p className="mb-2 text-sm font-semibold text-foreground">{block.title}</p>
      )}

      <div className="flex flex-col gap-1">
        {rows.map((row, i) => (
          <div key={row.key} className="group flex items-center gap-1.5">
            <span className="flex w-5 shrink-0 justify-center text-[11px] text-muted-foreground">
              {i + 1}
            </span>
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground/40" />
            <input
              value={row.text}
              onChange={(e) => edit(row.key, e.target.value)}
              disabled={disabled}
              dir="auto"
              placeholder={t("interactive.stepPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm outline-none hover:border-border focus:border-primary focus:bg-background"
            />
            <button
              type="button"
              onClick={() => insertAfter(i)}
              disabled={disabled}
              aria-label={t("interactive.addStep")}
              title={t("interactive.addStep")}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:text-primary group-hover:opacity-100 disabled:hidden"
            >
              <Plus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => remove(row.key)}
              disabled={disabled}
              aria-label={t("interactive.deleteStep")}
              title={t("interactive.deleteStep")}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100 disabled:hidden"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={addEnd}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" />
          {t("interactive.addStep")}
        </button>

        {confirmed ? (
          <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
            <Check className="size-3 text-primary" />
            {t("interactive.planSent")}
          </span>
        ) : (
          <button
            type="button"
            onClick={confirm}
            disabled={liveSteps === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            <Check className="size-3.5" />
            {t("interactive.planConfirm")}
          </button>
        )}
      </div>
    </div>
  );
}
