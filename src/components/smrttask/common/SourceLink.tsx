"use client";

import { Mail, MessageCircle, FolderOpen, Calendar, FileQuestion, ExternalLink, Send } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Rewrite a web URL into something the OS can hand off to the installed
 * native app (Gmail, WhatsApp, Drive, Calendar). On mobile we also avoid
 * `target="_blank"` (see handleClick below) because some iOS Safari builds
 * skip Universal-Link interception when the link opens a new tab.
 */
function toAppFriendlyUrl(sourceType: string | null, webUrl: string): string {
  // WhatsApp: switch wa.me → whatsapp:// so the app opens directly when installed.
  // The official wa.me URL also opens the app, but the explicit scheme skips a redirect.
  if (sourceType === "whatsapp" || sourceType === "whatsapp_echo") {
    const m = webUrl.match(/wa\.me\/(\d+)/);
    if (m) return `whatsapp://send?phone=${m[1]}`;
  }
  // Gmail / Drive / Calendar: web URL already triggers Universal Links / App Links
  // when the user has the app installed. No rewrite needed.
  return webUrl;
}

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
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (stopPropagation) e.stopPropagation();

      // Mobile path: navigate in the same tab to a possibly app-scheme URL.
      // Same-tab nav lets iOS/Android intercept the URL and open the native
      // app — `target="_blank"` breaks Universal Links on some iOS builds.
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
        e.preventDefault();
        const target = toAppFriendlyUrl(row.source_type, row.source_url!);
        window.location.href = target;
      }
      // Desktop path: let the anchor's target="_blank" open a new tab.
    };

    return (
      <a
        href={row.source_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
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
