"use client";

/**
 * AskBlock — an explained multiple-choice Claude puts on screen.
 *
 * The user reads the one-line "what this means" on each option and clicks one.
 * That single click is BOTH the answer to Claude's question AND the approval
 * (per the in-app-approval rule: when the price/consequence is visible at the
 * point of action, the click is the sign-off). No typing, no free-text round
 * trip. The escape hatch — a free-text "other" — is always offered unless the
 * block explicitly turns it off, because some answers (a name, an endpoint id,
 * a sum) can't be enumerated as buttons.
 *
 * Answering sends an ordinary follow-up turn; the engine session already holds
 * the question in context. Once a newer turn exists this block is no longer the
 * last word, so it renders read-only (`interactive={false}`) — the history stays
 * legible instead of inviting a second, stale answer.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, CornerDownLeft, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AskBlock as AskBlockData } from "./blocks";

export function AskBlock({
  block,
  interactive,
  onSubmit,
}: {
  block: AskBlockData;
  interactive: boolean;
  /** Send the chosen answer as a follow-up turn. */
  onSubmit: (message: string) => void;
}) {
  const t = useTranslations("claudeChat");
  // Local latch: once the user picks, disable the whole block immediately so a
  // double-click can't queue two turns. The label picked is shown as confirmed.
  const [picked, setPicked] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  const disabled = !interactive || picked !== null;

  function choose(label: string, message: string) {
    if (disabled) return;
    setPicked(label);
    onSubmit(message);
  }

  function sendOther() {
    const text = otherText.trim();
    if (disabled || !text) return;
    choose(text, text);
  }

  return (
    <div
      dir="auto"
      className={cn(
        "my-3 rounded-xl border bg-muted/20 p-3",
        !interactive && "opacity-70",
      )}
    >
      {block.question && (
        <p className="mb-2 text-sm font-semibold text-foreground" dir="auto">
          {block.question}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {block.options.map((opt, i) => {
          const isPicked = picked === opt.label;
          return (
            <button
              key={`${opt.label}-${i}`}
              type="button"
              disabled={disabled}
              onClick={() => choose(opt.label, t("interactive.picked", { label: opt.label }))}
              dir="auto"
              className={cn(
                "group flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-start transition",
                "enabled:hover:border-primary enabled:hover:bg-primary/5",
                "disabled:cursor-default",
                isPicked && "border-primary bg-primary/10",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  isPicked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
              >
                {isPicked && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                {opt.detail && (
                  <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                    {opt.detail}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Free-text escape hatch — the "other" that keeps an un-enumerable answer
          possible. Hidden until asked for, matching the compact-UI rule. */}
      {block.allowOther !== false && !otherOpen && picked === null && interactive && (
        <button
          type="button"
          onClick={() => setOtherOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <Pencil className="size-3" />
          {t("interactive.other")}
        </button>
      )}

      {otherOpen && picked === null && interactive && (
        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendOther();
              }
            }}
            rows={1}
            dir="auto"
            autoFocus
            placeholder={t("interactive.otherPlaceholder")}
            className="min-h-9 flex-1 resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={sendOther}
            disabled={!otherText.trim()}
            aria-label={t("interactive.send")}
            title={t("interactive.send")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-primary text-primary-foreground transition enabled:hover:opacity-90 disabled:opacity-40"
          >
            <CornerDownLeft className="size-4" />
          </button>
        </div>
      )}

      {picked !== null && (
        <p className="mt-2 inline-flex items-center gap-1 text-[12px] text-muted-foreground">
          <Check className="size-3 text-primary" />
          {t("interactive.sent", { label: picked })}
        </p>
      )}
    </div>
  );
}
