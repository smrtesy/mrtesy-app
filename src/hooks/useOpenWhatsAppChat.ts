"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { useOptionalPaneNav } from "@/lib/panes/nav";
import { isEmbeddedPane, requestOpenTab } from "@/lib/navigate";

interface OpenWhatsAppOpts {
  /** wamid to scroll-to + highlight — deep-links straight to the message. */
  focusWamid?: string | null;
  /** One-shot draft to prefill the composer. Only honoured on the docked-panel
   *  path (it can't be carried through the /whatsapp URL). */
  draft?: string | null;
  /**
   * Keep the current pane alive by opening WhatsApp in a NEW workspace pane
   * instead of replacing this one. Set by full-screen flows — the marathon /
   * focus run — that would otherwise be torn down by a same-pane navigation,
   * abandoning the session. Falls back to replacing the pane if the workspace
   * can't be reached. Ignored outside a pane.
   */
  preservePane?: boolean;
  /** Header label for the new pane when `preservePane` opens one. */
  paneLabel?: string;
}

/**
 * Single source of truth for "open a WhatsApp conversation" across the app.
 *
 * Outside a workspace pane it surfaces the docked side-panel (openChat/open),
 * keeping the current screen in place. Inside a pane the docked panel is the
 * wrong surface (in a legacy iframe pane it's force-hidden by the
 * `html[data-embed="1"] .wa-panel` CSS — a dead button; in a component pane it
 * would cover the whole workspace), so we route to the full `/whatsapp` reader
 * instead, carrying the same chat + message anchor (WhatsAppPageClient reads
 * chat_id/msg).
 *
 * Pane detection covers BOTH pane generations: `useOptionalPaneNav()` for
 * component panes (same React tree — the workspace context is reachable
 * directly) and `isEmbeddedPane()` for legacy iframe panes (separate document —
 * reachable only via postMessage). See docs/router-panes-plan.md.
 *
 * This guard used to be copy-pasted per surface (SourceLink, the marathon run,
 * the sources log), and every new call site that forgot it reintroduced the
 * dead-button bug. Route every WhatsApp-source open through here instead.
 */
export function useOpenWhatsAppChat() {
  const waPanel = useWhatsAppPanel();
  const router = useRouter();
  const tabs = useOptionalTabsWorkspace();
  const paneNav = useOptionalPaneNav();
  const { locale } = useParams() as { locale: string };

  return useCallback(
    (phone: string | null, opts: OpenWhatsAppOpts = {}) => {
      const { focusWamid = null, draft = null, preservePane = false, paneLabel } = opts;

      const inComponentPane = paneNav !== null;
      const inIframePane = isEmbeddedPane();

      if (inComponentPane || inIframePane) {
        const params = new URLSearchParams();
        if (phone) params.set("chat_id", phone);
        if (focusWamid) params.set("msg", focusWamid);
        // Nonce: re-clicking the SAME chat must still re-apply the deep link
        // (the reader's seed effect keys on the search string; without this a
        // second identical href is deduped away and nothing happens).
        params.set("ts", String(Date.now()));
        const qs = params.toString();
        const href = `/${locale}/whatsapp${qs ? `?${qs}` : ""}`;

        // A full-screen run shouldn't lose its session — open WhatsApp beside
        // it as a new pane. Component panes reach the workspace directly;
        // iframe panes post a message. Fall back to replacing this pane
        // (better a live WhatsApp than a dead button).
        if (preservePane) {
          if (inComponentPane && tabs) {
            tabs.openTab(href, paneLabel ?? "WhatsApp");
            return;
          }
          if (inIframePane && requestOpenTab(href, paneLabel ?? "WhatsApp")) return;
        }

        if (inComponentPane) paneNav.push(href);
        else router.push(href);
        return;
      }

      if (phone) waPanel.openChat(phone, draft, focusWamid);
      else waPanel.open();
    },
    [waPanel, router, tabs, paneNav, locale],
  );
}
