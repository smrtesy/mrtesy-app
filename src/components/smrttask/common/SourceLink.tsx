"use client";

import { useParams } from "next/navigation";
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
  const { locale } = useParams<{ locale: string }>();
  const row: SourceRow | null = Array.isArray(source) ? (source[0] ?? null) : (source ?? null);
  if (!row?.serial_display && !row?.source_url) return null;

  const Icon = SOURCE_ICONS[row.source_type ?? ""] ?? FileQuestion;
  const label = row.serial_display ?? "?";

  const base = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted/40";
  const interactive = "hover:bg-muted hover:text-foreground transition-colors";

  // WhatsApp sources route to the in-app reader rather than wa.me — the user
  // wants the conversation in the platform thread view, not a new chat in the
  // native WhatsApp client.
  const isWhatsapp = row.source_type === "whatsapp" || row.source_type === "whatsapp_echo";
  if (isWhatsapp) {
    // Backend stores wa.me/<digits-only>; we still strip non-digits defensively
    // so a malformed URL (e.g. wa.me/+972…) degrades to "open WhatsApp tab"
    // rather than silently linking to an unknown chat.
    const phone = ((row.source_url ?? "").match(/wa\.me\/([^?#]+)/)?.[1] ?? "").replace(/\D/g, "");
    const href = phone
      ? `/${locale ?? "he"}/whatsapp?chat_id=${encodeURIComponent(phone)}`
      : `/${locale ?? "he"}/whatsapp`;
    return (
      <a
        href={href}
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
        title={`${label} — open in WhatsApp tab`}
        className={cn(base, interactive, className)}
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
      </a>
    );
  }

  if (row.source_url) {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (stopPropagation) e.stopPropagation();

      if (typeof window === "undefined") return;
      if (!window.matchMedia("(max-width: 767px)").matches) return;

      // Universal Links (iOS) and App Links (Android) require same-tab navigation.
      // target="_blank" creates a new browsing context which bypasses OS-level
      // app interception; target="_self" lets the OS intercept the mail.google.com
      // URL and open it in Gmail with the full fragment (#all/MSGID) intact.
      // The Intent URL approach was removed because Chrome encodes # as %23 in
      // the Intent data URI, causing Gmail to miss the thread fragment and fall
      // back to opening the Gmail website in the browser.
      e.currentTarget.target = "_self";
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
