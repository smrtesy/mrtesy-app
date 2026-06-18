"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Maximize2 } from "lucide-react";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { WhatsAppReader } from "./WhatsAppReader";

const WIDTH_KEY = "smrtesy.waPanel.width";
// Resize bounds for the docked panel (desktop). Min keeps the composer usable;
// max leaves a usable strip of main content beside it.
const MIN_PANEL_PX = 320;
function maxPanelPx() {
  if (typeof window === "undefined") return 1200;
  // Leave room for the main content (so a centered modal docked beside the
  // panel still fits) while also never exceeding 85% of the viewport.
  return Math.max(MIN_PANEL_PX, Math.min(window.innerWidth * 0.85, window.innerWidth - 480));
}

/**
 * Docked WhatsApp side-panel. On desktop it occupies the inline-end half of
 * the viewport (the main content is pushed aside by `body[data-wa-panel]` in
 * globals.css); on mobile it covers the screen as a full overlay. Mounted once
 * in the app shell — renders nothing until the panel is opened.
 */
export function WhatsAppPanel() {
  const { isOpen, seedChatId, seedDraft, seedFocusWamid, session, close } = useWhatsAppPanel();
  const pathname = usePathname();
  const { locale } = useParams();
  const t = useTranslations("whatsappPage");
  const isHe = locale === "he";

  // Track the conversation actually open in the reader so "expand" lands on it.
  const [activeChatId, setActiveChatId] = useState<string | null>(seedChatId);

  // User-resizable width (desktop). Stored in px and exposed to CSS as
  // --wa-panel-width, which both the panel and the main-content push read.
  // null = not yet hydrated → CSS falls back to the 50vw default.
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  // The full /whatsapp page already is the reader — don't stack a second copy
  // (or squeeze that page) on top of it.
  const onWhatsAppPage = Boolean(pathname && pathname.includes("/whatsapp"));
  const visible = isOpen && !onWhatsAppPage;

  // Hydrate the saved width once on mount (client-only, avoids SSR mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTH_KEY);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n)) {
        setPanelWidth(Math.max(MIN_PANEL_PX, Math.min(n, maxPanelPx())));
      }
    } catch {
      /* private mode / quota — fall back to the CSS default */
    }
  }, []);

  // Push the main content aside on desktop while the panel is docked, and
  // publish the chosen width to CSS. Cleared on close so other pages reset.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) {
      document.body.setAttribute("data-wa-panel", "true");
      if (panelWidth != null) {
        document.body.style.setProperty("--wa-panel-width", `${panelWidth}px`);
      }
    } else {
      document.body.removeAttribute("data-wa-panel");
      document.body.style.removeProperty("--wa-panel-width");
    }
    return () => {
      document.body.removeAttribute("data-wa-panel");
      document.body.style.removeProperty("--wa-panel-width");
    };
  }, [visible, panelWidth]);

  // Persist the committed width (one write per drag — the value is only
  // pushed to state on pointerup, not on every move).
  useEffect(() => {
    if (panelWidth == null) return;
    try {
      window.localStorage.setItem(WIDTH_KEY, String(panelWidth));
    } catch {
      /* non-fatal */
    }
  }, [panelWidth]);

  // Drag-to-resize. The panel is anchored at the inline-end screen edge, so
  // the panel width is the distance from that edge to the pointer — which is
  // clientX in RTL (panel on the physical left) and innerWidth-clientX in LTR
  // (panel on the physical right). During the drag we write --wa-panel-width
  // straight to <body> (imperative) so the resize is smooth without
  // re-rendering the heavy reader on every move; the value is committed to
  // React state only on release (for persistence).
  const latestWidthRef = useRef<number | null>(null);
  const onResizeMove = useCallback(
    (clientX: number) => {
      const raw = isHe ? clientX : window.innerWidth - clientX;
      const w = Math.max(MIN_PANEL_PX, Math.min(raw, maxPanelPx()));
      latestWidthRef.current = w;
      document.body.style.setProperty("--wa-panel-width", `${w}px`);
    },
    [isHe],
  );
  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizing(true);
  }, []);
  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing) return;
      onResizeMove(e.clientX);
    },
    [resizing, onResizeMove],
  );
  const onHandlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing) return;
      setResizing(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      if (latestWidthRef.current != null) setPanelWidth(latestWidthRef.current);
    },
    [resizing],
  );
  // Double-click the handle to reset to the default width.
  const resetWidth = useCallback(() => {
    setPanelWidth(Math.round((typeof window === "undefined" ? 1000 : window.innerWidth) / 2));
  }, []);

  if (!visible) return null;

  // Carry the focused message into the full page only while the originally
  // seeded chat is still the active one — once the user navigates to another
  // conversation the anchor no longer applies.
  const expandHref = activeChatId
    ? `/${locale}/whatsapp?chat_id=${encodeURIComponent(activeChatId)}` +
      (seedFocusWamid && activeChatId === seedChatId
        ? `&msg=${encodeURIComponent(seedFocusWamid)}`
        : "")
    : `/${locale}/whatsapp`;

  return (
    <aside
      dir={isHe ? "rtl" : "ltr"}
      aria-label={t("title")}
      className={`wa-panel fixed inset-0 z-[60] flex flex-col bg-card md:inset-y-0 md:end-0 md:start-auto md:border-s md:shadow-xl ${
        resizing ? "select-none" : ""
      }`}
    >
      {/* Resize handle — sits on the panel's inline-start edge (the side facing
          the main content). Desktop only; drag to widen/narrow, double-click to
          reset. The wide invisible hit-area makes it easy to grab; the thin
          visible bar shows on hover/drag. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resizePanel")}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onDoubleClick={resetWidth}
        className="absolute inset-y-0 start-0 z-10 hidden w-2 -ms-1 cursor-col-resize touch-none md:block group/resize"
      >
        <div
          className={`mx-auto h-full w-0.5 transition-colors ${
            resizing ? "bg-primary" : "bg-transparent group-hover/resize:bg-primary/40"
          }`}
        />
      </div>

      <div className="flex items-center gap-2 border-b bg-muted/40 p-2">
        <span className="flex-1 truncate text-sm font-semibold">{t("title")}</span>
        <Link
          href={expandHref}
          onClick={close}
          title={t("expandFull")}
          aria-label={t("expandFull")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Maximize2 className="h-4 w-4" />
        </Link>
        <button
          type="button"
          onClick={close}
          title={t("closePanel")}
          aria-label={t("closePanel")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <WhatsAppReader
        key={session}
        layout="stacked"
        initialChatId={seedChatId}
        initialDraft={seedDraft}
        initialFocusWamid={seedFocusWamid}
        onActiveChatChange={setActiveChatId}
        className="flex-1 p-2"
      />
    </aside>
  );
}
