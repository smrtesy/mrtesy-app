"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { isEmbeddedPane, requestOpenTab } from "@/lib/navigate";

interface OpenWhatsAppOpts {
  /** wamid to scroll-to + highlight — deep-links straight to the message. */
  focusWamid?: string | null;
  /** One-shot draft to prefill the composer. Only honoured on the docked-panel
   *  path (it can't be carried through the /whatsapp URL). */
  draft?: string | null;
  /**
   * Keep the current pane alive by opening WhatsApp in a NEW workspace pane
   * (via requestOpenTab) instead of replacing this one. Set by full-screen
   * flows — the marathon / focus run — that would otherwise be torn down by a
   * same-pane navigation, abandoning the session. Falls back to replacing the
   * pane if the workspace can't be reached. Ignored outside an embedded pane.
   */
  preservePane?: boolean;
  /** Header label for the new pane when `preservePane` opens one. */
  paneLabel?: string;
}

/**
 * Single source of truth for "open a WhatsApp conversation" across the app.
 *
 * Outside a workspace pane it surfaces the docked side-panel (openChat/open),
 * keeping the current screen in place. Inside a tabs-workspace pane the docked
 * panel is force-hidden by CSS (`html[data-embed="1"] .wa-panel { display:none }`
 * in globals.css), so calling openChat() there flips state but renders nothing —
 * a dead button. In that case we route to the full `/whatsapp` reader instead,
 * carrying the same chat + message anchor (WhatsAppPageClient reads chat_id/msg).
 *
 * This guard used to be copy-pasted per surface (SourceLink, the marathon run,
 * the sources log), and every new call site that forgot it reintroduced the
 * dead-button bug. Route every WhatsApp-source open through here instead.
 */
export function useOpenWhatsAppChat() {
  const waPanel = useWhatsAppPanel();
  const router = useRouter();
  const { locale } = useParams() as { locale: string };

  return useCallback(
    (phone: string | null, opts: OpenWhatsAppOpts = {}) => {
      const { focusWamid = null, draft = null, preservePane = false, paneLabel } = opts;

      if (isEmbeddedPane()) {
        const params = new URLSearchParams();
        if (phone) params.set("chat_id", phone);
        if (focusWamid) params.set("msg", focusWamid);
        const qs = params.toString();
        const href = `/${locale}/whatsapp${qs ? `?${qs}` : ""}`;
        // A full-screen run shouldn't lose its session — open WhatsApp beside
        // it as a new pane. If the workspace message can't be posted, fall back
        // to replacing this pane (better a live WhatsApp than a dead button).
        if (preservePane && requestOpenTab(href, paneLabel ?? "WhatsApp")) return;
        router.push(href);
        return;
      }

      if (phone) waPanel.openChat(phone, draft, focusWamid);
      else waPanel.open();
    },
    [waPanel, router, locale],
  );
}
