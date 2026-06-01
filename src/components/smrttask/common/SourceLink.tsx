"use client";

import { useEffect, useState } from "react";
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

type SourceRow = {
  source_type: string | null;
  source_url: string | null;
  serial_display: string | null;
  /** source_messages.metadata jsonb — gmail rows carry { rfc822MsgId } here */
  metadata?: { rfc822MsgId?: string | null } | null;
};

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

  // Mobile Gmail: build a per-message URL and store it in state so the anchor
  // carries the right href BEFORE the user taps (avoids onClick timing races).
  //
  // The desktop source_url uses the "#all/<internalId>" fragment. That format
  // is desktop-web only — mobile Gmail (both the app and m.gmail web) ignores
  // it and lands the user on the inbox. The RFC-822 Message-ID is the only
  // identifier that survives into mobile Gmail, so on mobile we route through a
  // "#search/rfc822msgid:" query that resolves to the one specific message.
  const sourceType = row?.source_type ?? null;
  const rfc822MsgId =
    sourceType === "gmail" || sourceType === "gmail_sent"
      ? (row?.metadata?.rfc822MsgId ?? null)
      : null;
  const [mobileGmailHref, setMobileGmailHref] = useState<string | null>(null);
  useEffect(() => {
    if (!rfc822MsgId) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    setMobileGmailHref(
      `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(rfc822MsgId)}`
    );
  }, [rfc822MsgId]);

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
      // Mobile Gmail with a known Message-ID already has the #search href from
      // useEffect. Everything else on mobile (Gmail rows missing the Message-ID,
      // Drive, Calendar, iOS Universal Links): switch to same-tab navigation so
      // the OS / Gmail web can intercept the URL instead of opening a dead tab.
      if (!mobileGmailHref) e.currentTarget.target = "_self";
    };

    return (
      <a
        href={mobileGmailHref ?? row.source_url}
        target={mobileGmailHref ? "_self" : "_blank"}
        rel={mobileGmailHref ? undefined : "noopener noreferrer"}
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
