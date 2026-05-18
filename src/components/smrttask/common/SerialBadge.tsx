"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface SerialBadgeProps {
  /** Display string: "T42", "G127", etc. */
  serial: string | null | undefined;
  /** Stop click propagation (e.g. inside a Card that has its own onClick) */
  stopPropagation?: boolean;
  className?: string;
}

/**
 * Small monospaced tag showing a row's human-readable serial number.
 * Click copies the serial to the clipboard so the user can paste it
 * into a chat ("what happened to T42?").
 */
export function SerialBadge({ serial, stopPropagation, className }: SerialBadgeProps) {
  const [copied, setCopied] = useState(false);
  if (!serial) return null;

  async function handleClick(e: React.MouseEvent) {
    if (stopPropagation) e.stopPropagation();
    try {
      await navigator.clipboard.writeText(serial!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — fall through silently */
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? "Copied" : `Copy ${serial}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted/40 hover:bg-muted hover:text-foreground transition-colors",
        className,
      )}
    >
      <span>{serial}</span>
      {copied
        ? <Check className="h-2.5 w-2.5 text-green-600" />
        : <Copy className="h-2.5 w-2.5 opacity-60" />}
    </button>
  );
}
