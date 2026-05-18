"use client";

import { Mail, MessageCircle, FolderOpen, Calendar, FileQuestion, ExternalLink, Send } from "lucide-react";
import { cn } from "@/lib/utils";

const SOURCE_ICONS: Record<string, typeof Mail> = {
  gmail:           Mail,
  gmail_sent:      Send,
  whatsapp:        MessageCircle,
  whatsapp_echo:   MessageCircle,
  google_drive:    FolderOpen,
  google_calendar: Calendar,
};

type SourceRow = { source_type: string | null; source_url: string | null; serial_display: string | null };

interface SourceLinkProps {
  /**
   * From the source_messages join — null/undefined renders nothing.
   * Accepts either the joined object or a 1-element array (Supabase
   * sometimes returns the latter when it can't infer the FK direction).
   */
  source: SourceRow | SourceRow[] | null | undefined;
  /** Stop click propagation (e.g. inside a Card that has its own onClick) */
  stopPropagation?: boolean;
  className?: string;
}

/**
 * Small badge showing the source serial (G42 / W7 / D3 / …) with an icon for
 * the source type. If the source row has a URL the badge becomes a link that
 * opens the original message/doc in a new tab.
 */
export function SourceLink({ source, stopPropagation, className }: SourceLinkProps) {
  const row: SourceRow | null = Array.isArray(source) ? (source[0] ?? null) : (source ?? null);
  if (!row?.serial_display && !row?.source_url) return null;

  const Icon = SOURCE_ICONS[row.source_type ?? ""] ?? FileQuestion;
  const label = row.serial_display ?? "?";

  const base = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted/40";
  const interactive = "hover:bg-muted hover:text-foreground transition-colors";

  if (row.source_url) {
    return (
      <a
        href={row.source_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
        title={`${label} — open source`}
        className={cn(base, interactive, className)}
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
        <ExternalLink className="h-2.5 w-2.5 opacity-70" />
      </a>
    );
  }

  // Has serial but no URL — just a tag, not clickable
  return (
    <span title={label} className={cn(base, className)}>
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </span>
  );
}
