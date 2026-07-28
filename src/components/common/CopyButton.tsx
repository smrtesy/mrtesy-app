"use client";

/**
 * A quiet copy-to-clipboard button.
 *
 * Extracted from the markdown renderer's code block so the chat can copy a whole
 * message with the same affordance instead of growing a second, slightly
 * different one. The behaviour that matters is the feedback: a click that copies
 * nothing looks identical to one that worked, so the icon flips to a check for
 * `FEEDBACK_MS` and the accessible name changes with it.
 *
 * Clipboard access fails in an insecure context or when the permission is
 * denied. That is unrecoverable here, so the button simply does not flip — it
 * never claims a copy that did not happen.
 *
 * COMPACT BY DEFAULT (CLAUDE.md): `reveal` keeps it invisible until the group it
 * lives in is hovered, so it is not permanent chrome. Keyboard focus and touch
 * still reveal it — an affordance a keyboard user can never see is not an
 * affordance.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

const FEEDBACK_MS = 1500;

export function CopyButton({
  text,
  label,
  copiedLabel,
  className,
  /** Tailwind group name to hide behind until hover, e.g. "code" → group-hover/code. */
  reveal,
}: {
  /** Resolved lazily so a caller does not have to flatten a large string on every
   *  render just to have it ready for a click that may never come. */
  text: string | (() => string);
  label: string;
  copiedLabel: string;
  className?: string;
  reveal?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // Cleared on unmount: a component that disappears inside the feedback window
  // (a thread switched away from, a re-render that drops the turn) would
  // otherwise set state on something no longer mounted.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), FEEDBACK_MS);
    } catch {
      /* clipboard blocked (insecure context / denied) — nothing to recover */
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-opacity hover:text-foreground",
        reveal && [
          "opacity-0 focus-visible:opacity-100",
          // Written out rather than interpolated: Tailwind scans source text, so
          // a `group-hover/${reveal}` template literal produces no class at all.
          reveal === "code" && "group-hover/code:opacity-100",
          reveal === "msg" && "group-hover/msg:opacity-100",
          // A touch device has no hover, so a revealed-on-hover control would be
          // permanently invisible there.
          "touch:opacity-100",
        ],
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-status-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}
