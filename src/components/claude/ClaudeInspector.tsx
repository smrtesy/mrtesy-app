"use client";

/**
 * Inspect mode — "לסמן מקום באפליקציה" and have Claude identify and fix it.
 *
 * Mounted ONCE in the app layout (zero chrome while idle — nothing renders until
 * armed). Armed from the Claude chat's crosshair button (a window event) or with
 * Alt+Shift+C from any screen. While armed, a full-screen overlay turns the cursor
 * into a picker: hover highlights the component under the pointer, a click captures
 * it, Esc cancels.
 *
 * What a click captures: the current route, a compact selector chain of the element
 * and its ancestors, its visible text, and a bounded HTML snippet — enough for
 * Claude (with the app repo cloned) to grep its way to the exact component. The
 * capture is stored as a seed (sessionStorage + a window event for an
 * already-mounted chat), the screen navigates to /claude, and the seed lands in the
 * composer as a draft: the user adds what's wrong and sends.
 *
 * The overlay intercepts EVERY pointer event while armed (the devtools-picker
 * model): picking is a mode, entered deliberately and left by Esc/cancel/click.
 * Inside iframe panes the pick resolves to the <iframe> element itself (events
 * inside a frame never reach this document) — the seed then carries the frame's
 * URL, which still names the screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Crosshair, X } from "lucide-react";

const SEED_KEY = "smrtesy-claude-inspect-seed";
/** The platform's own repository — where the marked component's code lives. This is
 *  the app's identity, the same for every tenant, not tenant data. */
export const APP_REPO = "smrtesy/mrtesy-app";
export const APP_BRANCH = "main";
const ARM_EVENT = "smrtesy:claude-inspect-arm";
const SEED_EVENT = "smrtesy:claude-inspect-seed";

export interface InspectSeed {
  text: string;
  repo: string;
  branch: string;
}

/**
 * Deliver a composer seed exactly like an inspect capture does. Shared by every
 * "send this to Claude" entry point (the picker below, the system-messages
 * bell's error button) so they all speak the one contract ClaudeChat reads.
 * Both channels on purpose: the event reaches a Claude pane that is already
 * mounted (which would never re-run its mount-time read); the storage covers
 * the not-yet-mounted case and survives the navigation. Caller navigates to
 * /claude afterwards.
 */
export function deliverInspectSeed(seed: InspectSeed) {
  try {
    sessionStorage.setItem(SEED_KEY, JSON.stringify(seed));
  } catch {
    // Storage full/blocked — the event alone still covers the mounted case.
  }
  window.dispatchEvent(new CustomEvent(SEED_EVENT, { detail: seed }));
}

/** tag#id.class1.class2 — enough to grep for, short enough to read. */
function compactSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}`
      : "";
  return `${tag}${id}${cls}`;
}

/** The element's ancestor chain, outermost first, bounded so a deep tree cannot
 *  produce a page-long seed. */
function selectorChain(el: Element): string {
  const chain: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 8; i += 1) {
    chain.push(compactSelector(cur));
    cur = cur.parentElement;
  }
  return chain.reverse().join(" > ");
}

export function ClaudeInspector() {
  const t = useTranslations("claudeChat.inspect");
  const locale = useLocale();
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hoverElRef = useRef<Element | null>(null);

  useEffect(() => {
    const arm = () => setArmed(true);
    const onKey = (e: KeyboardEvent) => {
      // Not while typing: on macOS Alt+Shift+C is a real character ("Ç"), and
      // stealing it from an input would eat the keystroke.
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT")
      ) {
        return;
      }
      if (e.altKey && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        setArmed((v) => !v);
      }
    };
    window.addEventListener(ARM_EVENT, arm);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(ARM_EVENT, arm);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Esc leaves the mode — registered only while armed, so idle cost is zero.
  useEffect(() => {
    if (!armed) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setArmed(false);
        setRect(null);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [armed]);

  /** The topmost real element under the pointer — our own overlay UI excluded. */
  const elementAt = useCallback((x: number, y: number): Element | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest("[data-claude-inspect]")) continue;
      return el;
    }
    return null;
  }, []);

  const onMove = useCallback(
    (e: React.MouseEvent) => {
      const el = elementAt(e.clientX, e.clientY);
      hoverElRef.current = el;
      setRect(el ? el.getBoundingClientRect() : null);
    },
    [elementAt],
  );

  const capture = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAt(e.clientX, e.clientY) ?? hoverElRef.current;
      setArmed(false);
      setRect(null);
      if (!el) return;

      const route = `${window.location.pathname}${window.location.search}`;
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      const html = el.outerHTML.slice(0, 600);
      const frameSrc = el instanceof HTMLIFrameElement ? el.src : null;

      const lines = [
        t("seedHeader"),
        "",
        `- ${t("seedRoute")}: \`${route}\``,
        `- ${t("seedElement")}: \`${compactSelector(el)}\``,
        ...(text ? [`- ${t("seedText")}: "${text}"`] : []),
        ...(frameSrc ? [`- ${t("seedFrame")}: ${frameSrc}`] : []),
        `- ${t("seedChain")}: \`${selectorChain(el)}\``,
        "",
        "```html",
        html,
        "```",
        "",
        t("seedTask"),
        "",
        `${t("seedProblem")} `,
      ];
      deliverInspectSeed({ text: lines.join("\n"), repo: APP_REPO, branch: APP_BRANCH });
      router.push(`/${locale}/claude`);
    },
    [elementAt, locale, router, t],
  );

  if (!armed) return null;

  return (
    <>
      {/* The picker surface: everything under the pointer highlights, a click
          captures. Intercepts all pointer events — picking is a mode. */}
      <div
        data-claude-inspect
        className="fixed inset-0 z-[9990] cursor-crosshair"
        onMouseMove={onMove}
        onClick={capture}
      />

      {/* The highlight box over the hovered component. */}
      {rect && (
        <div
          data-claude-inspect
          className="pointer-events-none fixed z-[9991] rounded border-2 border-primary bg-primary/10"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      )}

      {/* The banner: what this mode is, how to leave it. */}
      <div
        data-claude-inspect
        className="fixed inset-x-0 top-2 z-[9992] mx-auto flex w-fit max-w-[92vw] items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs shadow-md"
      >
        <Crosshair className="size-3.5 shrink-0 text-primary" />
        <span dir="auto">{t("banner")}</span>
        <button
          type="button"
          onClick={() => {
            setArmed(false);
            setRect(null);
          }}
          aria-label={t("cancel")}
          title={t("cancel")}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </>
  );
}
