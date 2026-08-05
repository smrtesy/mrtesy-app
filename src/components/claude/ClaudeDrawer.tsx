"use client";

/**
 * ClaudeDrawer — the in-app Claude console as a floating, collapsible side chat.
 *
 * Opened from the app's EXISTING Claude entry points (the sidebar "קלוד" button
 * on desktop) via ClaudeDrawerContext — it has no launcher of its own, so there
 * is no second button for the same thing. It floats above whatever screen you're
 * on — NOT a full tab, NOT full screen height. Inside it hosts the real /claude
 * console in an iframe (`?embed=1`, which strips the app chrome), so the drawer
 * inherits every console feature and future change with zero duplication, and the
 * framed URL/router state stays fully isolated from the host screen it floats over.
 *
 * DESKTOP ONLY. On mobile the same Claude button navigates to the full /claude
 * screen instead (Sidebar) — a small floating box is the wrong shape on a phone —
 * so the drawer renders nothing under the mobile breakpoint even if a desktop
 * session left it open in localStorage.
 *
 * Bridge to the framed chat (the iframe is a separate document, so events and the
 * router don't cross into it): postMessage in both directions.
 *   → iframe: `claude-drawer:new` (open a fresh chat on every open — the button is
 *     "start something new", not "resume"), `claude-drawer:seed` (relay an inspect
 *     mark into the open chat), `claude-drawer:shown` (scroll to the latest).
 *   ← iframe: `claude-chat:title` (the live thread title, shown in the slim header).
 * The FIRST open loads the iframe already carrying `?new`, so the chat starts fresh
 * without a postMessage race; later opens (iframe kept alive) send `claude-drawer:new`.
 *
 * Two things make the iframe safe here:
 *   1. Recursion guard — the framed /claude loads (app)/layout.tsx again, which
 *      would mount a second ClaudeDrawer inside the frame. We render NOTHING when
 *      this window is itself embedded (isEmbeddedPane: framed OR ?embed=1), and
 *      globals.css also hides [data-claude-drawer] under html[data-embed="1"] as
 *      a belt-and-braces first-paint guard. So the drawer never nests.
 *   2. Admin-only — mounted in the layout behind `isAdmin`, matching the /claude
 *      routes' super-admin gate (a run executes shell on our host).
 *
 * Mounted once in the layout, it survives pane navigation (the layout doesn't
 * remount), and the iframe stays alive once opened so the conversation persists
 * while you toggle the drawer closed and open again.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X, Maximize2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { isEmbeddedPane } from "@/lib/navigate";
import { useClaudeDrawer } from "@/contexts/ClaudeDrawerContext";
import { DRAWER_RESEED_EVENT } from "./ClaudeInspector";

export function ClaudeDrawer({ locale }: { locale: string }) {
  const t = useTranslations("claudeDrawer");
  const { open, closeDrawer } = useClaudeDrawer();
  // Client-only gate. Starts false so the server render and the first client
  // render match (nothing), then flips to true only when this window is a real
  // top-level document — never inside the console's own iframe.
  const [enabled, setEnabled] = useState(false);
  // Under the mobile breakpoint the drawer is suppressed — the Claude button goes
  // to the full screen there instead (bug 9).
  const [isMobile, setIsMobile] = useState(false);
  // Mount the (heavy) iframe only after the first open, then keep it alive so
  // the conversation survives a close/reopen.
  const [loaded, setLoaded] = useState(false);
  // The framed app takes a moment to boot — show a spinner until its first load.
  const [ready, setReady] = useState(false);
  // The open thread's title, pushed up from the framed chat — the slim header
  // shows it instead of a generic icon + "קלוד" (bug 5).
  const [threadTitle, setThreadTitle] = useState("");
  // The open thread's id, pushed up from the framed chat — the expand button uses
  // it to continue THIS conversation in the full screen instead of opening the
  // latest. Null while the framed composer is still blank (nothing sent yet).
  const [threadId, setThreadId] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // True once the iframe has mounted at least once — distinguishes the first open
  // (iframe loads with ?new) from later opens (message the live chat instead).
  const openedOnceRef = useRef(false);

  useEffect(() => {
    if (!isEmbeddedPane()) setEnabled(true);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767.98px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Lazy-mount the iframe the first time the drawer opens (open may already be
  // true on mount, restored from localStorage by the provider).
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  function post(type: string) {
    iframeRef.current?.contentWindow?.postMessage({ type }, window.location.origin);
  }

  // On every open: start a fresh chat and jump to the bottom (bugs 3/8). The first
  // open is handled by the ?new the iframe loads with (no live listener yet to
  // race); later opens message the already-mounted chat.
  useEffect(() => {
    if (!open || !ready) return;
    if (openedOnceRef.current) {
      post("claude-drawer:new");
      post("claude-drawer:shown");
    } else {
      openedOnceRef.current = true;
    }
  }, [open, ready]);

  // The live thread title from the framed chat.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { type?: string; title?: string; threadId?: string | null } | null;
      if (d?.type === "claude-chat:title") {
        setThreadTitle(typeof d.title === "string" ? d.title : "");
        setThreadId(typeof d.threadId === "string" ? d.threadId : null);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Inspect mode fired with the drawer open — relay the captured mark (already in
  // sessionStorage) into the framed chat instead of navigating the whole tab (bug 1).
  useEffect(() => {
    const onReseed = () => post("claude-drawer:seed");
    window.addEventListener(DRAWER_RESEED_EVENT, onReseed);
    return () => window.removeEventListener(DRAWER_RESEED_EVENT, onReseed);
  }, []);

  // Escape closes the drawer while it is open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  if (!enabled || !loaded || isMobile) return null;

  return (
    <div data-claude-drawer>
      {/* The drawer — floating, deliberately NOT full height, clamped to the
          viewport on small screens. Kept in the DOM once opened (hidden rather
          than unmounted) so the iframe conversation survives a close/reopen.
          Sits on the inline-start corner, cleared past the desktop sidebar. */}
      <div
        className={cn(
          "fixed z-[60] flex flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl",
          "bottom-6 start-56",
          "w-[min(26rem,calc(100vw-2rem))] h-[min(38rem,calc(100dvh-7rem))]",
          !open && "hidden",
        )}
        role="dialog"
        aria-label={t("title")}
      >
        {/* Slim header: the open chat's title (not a generic icon + "קלוד"),
            plus expand and close. Lives outside the scrolling iframe, so it is
            always pinned at the top of the drawer. */}
        <header className="flex items-center gap-2 border-b px-3 py-1.5">
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            dir="auto"
            title={threadTitle || t("untitled")}
          >
            {threadTitle || t("untitled")}
          </span>
          <a
            href={
              threadId
                ? `/${locale}/claude?thread=${threadId}`
                : `/${locale}/claude?new=drawer-expand`
            }
            onClick={closeDrawer}
            aria-label={t("openFull")}
            title={t("openFull")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="size-4" />
          </a>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label={t("close")}
            title={t("close")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="relative min-h-0 w-full flex-1">
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={`/${locale}/claude?embed=1&new=drawer`}
            title={t("title")}
            onLoad={() => setReady(true)}
            className="h-full w-full border-0"
          />
        </div>
      </div>
    </div>
  );
}
