"use client";

/**
 * AnswerContent — renders a Claude answer, turning any embedded interactive
 * block (`smrt-ask` / `smrt-plan`) into a real widget while everything else
 * renders as normal chat markdown.
 *
 * A plain answer (no blocks) takes the untouched single-Markdown fast path, so
 * this changes nothing for the overwhelming majority of turns. Only when Claude
 * actually emits a block does the answer get split into ordered segments and
 * the widgets get mounted between the prose.
 *
 * `interactive` is true only for the LAST turn of the thread: once the user
 * answers a block a newer turn appears, the previous turn stops being last, and
 * its blocks re-render read-only. That gate is what stops a stale answer being
 * offered twice — it needs no per-block persistence.
 */

import { Markdown } from "@/components/common/Markdown";
import { splitInteractive, hasInteractive } from "./blocks";
import { AskBlock } from "./AskBlock";
import { PlanBlock } from "./PlanBlock";

export function AnswerContent({
  answer,
  interactive,
  onAction,
  className,
}: {
  answer: string;
  /** True only for the thread's last turn — see file header. */
  interactive: boolean;
  /** Send a follow-up turn (an answer to a block). May return a promise so a
   *  block can revert its "sent" latch if the turn fails to queue. */
  onAction: (message: string) => Promise<void> | void;
  className?: string;
}) {
  const segments = splitInteractive(answer);

  // Fast path: no widgets → render exactly as before, one Markdown pass.
  if (!hasInteractive(segments)) {
    return (
      <Markdown density="chat" className={className}>
        {answer}
      </Markdown>
    );
  }

  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === "md") {
          // Trim so a blank line around a block doesn't render an empty
          // paragraph; Markdown returns null for whitespace-only input anyway.
          return seg.text.trim() ? <Markdown key={i} density="chat">{seg.text}</Markdown> : null;
        }
        if (seg.kind === "ask") {
          return (
            <AskBlock key={i} block={seg.block} interactive={interactive} onSubmit={onAction} />
          );
        }
        return (
          <PlanBlock key={i} block={seg.block} interactive={interactive} onSubmit={onAction} />
        );
      })}
    </div>
  );
}
