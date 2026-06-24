"use client";

/**
 * Global state for the docked WhatsApp side-panel.
 *
 * The panel lets the operator keep a WhatsApp conversation open alongside
 * the task lists (inbox / tasks / etc.) instead of navigating away to the
 * full /whatsapp page and losing their place. On desktop it docks to the
 * inline-end half of the viewport (the main content is pushed aside via
 * `body[data-wa-panel]` in globals.css); on mobile it covers the screen as
 * a full overlay.
 *
 * Opening the panel auto-collapses the desktop sidebar to reclaim width and
 * restores the prior sidebar state on close — the sidebar's collapse flag
 * lives entirely on `<body data-sidebar-collapsed>` + localStorage (see
 * Sidebar.tsx), so we drive it from here through the same DOM contract.
 *
 * Consumers:
 *   <WhatsAppPanel>      — renders the docked reader when isOpen
 *   <WhatsAppPanelFab>   — floating toggle button (desktop)
 *   SourceLink / QuickAction / LogPageClient — call openChat() to surface a
 *                          specific conversation in the panel
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface WhatsAppPanelValue {
  isOpen: boolean;
  /** Chat to seed the reader with when the panel (re)opens. */
  seedChatId: string | null;
  /** One-shot draft to prefill the composer for the seeded chat. */
  seedDraft: string | null;
  /** One-shot wamid to scroll-to + highlight when the seeded chat opens. */
  seedFocusWamid: string | null;
  /** Bumped on every open so the reader remounts with fresh seed values. */
  session: number;
  /** Open the panel focused on a specific conversation (optionally with a
   *  prefilled draft and/or a specific message to jump to). */
  openChat: (chatId: string, draft?: string | null, focusWamid?: string | null) => void;
  /** Open the panel without a target — shows the chat list to pick from. */
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const Ctx = createContext<WhatsAppPanelValue | null>(null);

const STORAGE_KEY = "smrtesy.waPanel.v1";
const SIDEBAR_KEY = "smrtesy.sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  if (typeof document === "undefined") return false;
  return document.body.getAttribute("data-sidebar-collapsed") === "true";
}

function setSidebarCollapsed(collapsed: boolean) {
  if (typeof document === "undefined") return;
  document.body.setAttribute("data-sidebar-collapsed", collapsed ? "true" : "false");
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "true" : "false");
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function WhatsAppPanelProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [seedChatId, setSeedChatId] = useState<string | null>(null);
  const [seedDraft, setSeedDraft] = useState<string | null>(null);
  const [seedFocusWamid, setSeedFocusWamid] = useState<string | null>(null);
  const [session, setSession] = useState(0);

  // Sidebar state we collapsed away on open, to restore on close. null = we
  // haven't taken ownership (panel currently closed).
  const prevSidebarCollapsedRef = useRef<boolean | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate from localStorage so an open panel survives a refresh. We don't
  // touch the sidebar on hydrate (avoid clobbering the user's preference on
  // load); the content-push from data-wa-panel still applies.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    // Don't restore the panel inside an embedded workspace pane. Its state is
    // origin-global, so an open panel in the main window would otherwise leak
    // into every split pane — setting `data-wa-panel`, which repositions
    // dialogs and bumps their z-index over popovers (hiding date pickers).
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("embed") === "1"
    ) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { isOpen?: boolean; seedChatId?: string | null };
      if (parsed.isOpen) {
        setIsOpen(true);
        setSeedChatId(parsed.seedChatId ?? null);
      }
    } catch {
      /* corrupt value — ignore */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ isOpen, seedChatId }));
    } catch {
      /* non-fatal */
    }
  }, [isOpen, seedChatId]);

  const takeOverSidebar = useCallback(() => {
    if (prevSidebarCollapsedRef.current === null) {
      prevSidebarCollapsedRef.current = readSidebarCollapsed();
    }
    setSidebarCollapsed(true);
  }, []);

  const restoreSidebar = useCallback(() => {
    if (prevSidebarCollapsedRef.current !== null) {
      // Only restore if our forced-collapse is still in effect. If the user
      // manually re-opened the sidebar while the panel was up, respect that
      // choice instead of clobbering it back to the pre-open snapshot.
      if (readSidebarCollapsed()) {
        setSidebarCollapsed(prevSidebarCollapsedRef.current);
      }
      prevSidebarCollapsedRef.current = null;
    }
  }, []);

  const openChat = useCallback(
    (chatId: string, draft: string | null = null, focusWamid: string | null = null) => {
      setSeedChatId(chatId);
      setSeedDraft(draft);
      setSeedFocusWamid(focusWamid);
      setSession((s) => s + 1);
      setIsOpen(true);
      takeOverSidebar();
    },
    [takeOverSidebar],
  );

  const open = useCallback(() => {
    setSeedDraft(null);
    setSeedFocusWamid(null);
    setSession((s) => s + 1);
    setIsOpen(true);
    takeOverSidebar();
  }, [takeOverSidebar]);

  const close = useCallback(() => {
    setIsOpen(false);
    restoreSidebar();
  }, [restoreSidebar]);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [isOpen, open, close]);

  const value = useMemo<WhatsAppPanelValue>(
    () => ({ isOpen, seedChatId, seedDraft, seedFocusWamid, session, openChat, open, close, toggle }),
    [isOpen, seedChatId, seedDraft, seedFocusWamid, session, openChat, open, close, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWhatsAppPanel(): WhatsAppPanelValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWhatsAppPanel must be inside <WhatsAppPanelProvider>");
  return v;
}
