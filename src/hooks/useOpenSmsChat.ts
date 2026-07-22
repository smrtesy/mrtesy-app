"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { useOptionalPaneNav } from "@/lib/panes/nav";
import { isEmbeddedPane, requestOpenTab } from "@/lib/navigate";

/**
 * Parse the conversation peer from a source_messages.source_url stored as
 * `sms:<peer>` (both `sms` and `sms_echo` rows use this shape). Returns null for
 * anything that isn't an SMS source URL, so callers can branch on it.
 */
export function smsPeerFromSourceUrl(url: string | null | undefined): string | null {
  const v = (url ?? "").trim();
  return v.startsWith("sms:") ? v.slice(4) || null : null;
}

interface OpenSmsOpts {
  /**
   * Keep the current pane alive by opening the SMS reader in a NEW workspace
   * pane instead of replacing this one. Set by full-screen flows (the marathon
   * run) that would otherwise be torn down by a same-pane navigation. Falls back
   * to replacing the pane if the workspace can't be reached. Ignored outside a
   * pane.
   */
  preservePane?: boolean;
  /** Header label for the new pane when `preservePane` opens one. */
  paneLabel?: string;
}

/**
 * Single source of truth for "open an SMS conversation" across the app.
 *
 * SMS has no docked side-panel (unlike WhatsApp), so every surface routes to the
 * full `/sms` reader, carrying the peer as `?chat_id`. Pane-aware: inside a
 * workspace pane it swaps that pane (or opens a sibling tab when `preservePane`
 * is set, so a full-screen run isn't abandoned); outside a pane it's a plain
 * navigation. Mirrors useOpenWhatsAppChat's pane detection.
 *
 * Centralised so no surface renders the raw `sms:<peer>` URL as an href — an
 * `sms:` href fires the OS's native SMS composer instead of opening the in-app
 * thread. That was the reported bug: a task whose source was an SMS opened
 * `sms:+1408…` instead of the conversation.
 */
export function useOpenSmsChat() {
  const router = useRouter();
  const tabs = useOptionalTabsWorkspace();
  const paneNav = useOptionalPaneNav();
  const { locale } = useParams() as { locale: string };

  return useCallback(
    (peer: string | null, opts: OpenSmsOpts = {}) => {
      const { preservePane = false, paneLabel } = opts;

      const params = new URLSearchParams();
      if (peer) params.set("chat_id", peer);
      // Nonce: re-opening the SAME chat must re-apply the deep link. The reader
      // seeds off the search string, so a duplicate href would otherwise be
      // deduped away and nothing would happen.
      params.set("ts", String(Date.now()));
      const href = `/${locale}/sms?${params.toString()}`;

      const inComponentPane = paneNav !== null;
      const inIframePane = isEmbeddedPane();

      // Full-screen run: open SMS beside it as a new pane instead of navigating
      // this one away. Component panes reach the workspace directly; iframe
      // panes post a message. Fall back to replacing this pane.
      if (preservePane && (inComponentPane || inIframePane)) {
        if (inComponentPane && tabs) {
          tabs.openTab(href, paneLabel ?? "SMS");
          return;
        }
        if (inIframePane && requestOpenTab(href, paneLabel ?? "SMS")) return;
      }

      if (inComponentPane) paneNav.push(href);
      else router.push(href);
    },
    [router, tabs, paneNav, locale],
  );
}
