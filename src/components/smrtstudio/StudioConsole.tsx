"use client";

/**
 * smrtStudio — the operator console.
 *
 * A single read-only screen: a left rail of build stages, a default dashboard
 * of headline numbers, and a per-stage focus view (charter, tasks, expected
 * challenges, outputs). Every number is computed live by
 * GET /api/studio/overview — nothing here is hand-kept.
 *
 * The whole surface is scoped under `.ss-app`: its design tokens live on that
 * wrapper (never on :root, which would clash with the app's globals) and it is
 * forced `dir="ltr"` because all of its copy is English. Dark mode follows the
 * app (Tailwind `.dark` class) as well as the OS `prefers-color-scheme`.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { useLocale } from "next-intl";

import { api } from "@/lib/api/client";
import { Skeleton } from "@/components/ui/skeleton";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";

import type {
  StudioItem,
  StudioOverview,
  StudioStage,
  StudioStatus,
} from "./types";

/* ── icons (inner SVG markup, injected verbatim) ─────────────────────────── */

const ICON: Record<string, string> = {
  planning:
    '<path d="M9 4h6M9 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2"/><path d="M9 10h6M9 14h4"/>',
  tools:
    '<path d="M14.5 5.5a3.5 3.5 0 0 0-4.9 4.4L3 16.5 5.5 19l6.6-6.6a3.5 3.5 0 0 0 4.4-4.9l-2.2 2.2-2-2z"/>',
  script:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  chars:
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21"/>',
  voice:
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/>',
  sets: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  motion:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"/>',
  lipsync:
    '<path d="M21 12a8 8 0 0 1-8 8H8l-4 2 1-4A8 8 0 1 1 21 12z"/><path d="M9 12h.01M12.5 12h.01M16 12h.01"/>',
  assembly:
    '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 8.2v7.6M8.1 6.6h4.4A4 4 0 0 1 16 10.4M8.1 17.4h4.4A4 4 0 0 0 16 13.6"/>',
  market:
    '<path d="M4 10v4a1 1 0 0 0 1 1h3l5 4V5L8 9H5a1 1 0 0 0-1 1z"/><path d="M18 8.5a4 4 0 0 1 0 7"/>',
  cdone: '<circle cx="12" cy="12" r="9"/><path d="M8.4 12.4l2.4 2.4 4.8-5.2"/>',
  cnow: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
  ctodo: '<circle cx="12" cy="12" r="9"/>',
  check: '<path d="M5 12l5 5L20 6"/>',
  alert: '<path d="M12 3l9.5 16.5H2.5z"/><path d="M12 10v4M12 17.5v.01"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  checklist:
    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.2 1.2L7.5 5M4 12l1.2 1.2L7.5 11M4 18l1.2 1.2L7.5 17"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  img: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.8"/><path d="M21 16l-5-4.5L7 20"/>',
  aud: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/>',
  tool: '<path d="M14.5 5.5a3.5 3.5 0 0 0-4.9 4.4L3 16.5 5.5 19l6.6-6.6a3.5 3.5 0 0 0 4.4-4.9l-2.2 2.2-2-2z"/>',
};

const ST_META: Record<StudioStatus, { ic: string; tag: string }> = {
  done: { ic: "cdone", tag: "Done" },
  now: { ic: "cnow", tag: "In progress" },
  todo: { ic: "ctodo", tag: "Not started" },
};

const OUT_KIND: Record<
  StudioStage["outputs"][number]["kind"],
  { icon: string; c: string }
> = {
  image: { icon: "img", c: "hsl(200 var(--sat) var(--lit))" },
  video: { icon: "motion", c: "hsl(28 var(--sat) var(--lit))" },
  audio: { icon: "aud", c: "hsl(150 var(--sat) var(--lit))" },
  text: { icon: "doc", c: "hsl(235 var(--sat) var(--lit))" },
  tool: { icon: "tool", c: "hsl(265 var(--sat) var(--lit))" },
};

/** The three fixed phases every research stage shows, in order. Build stages
 *  ignore this and group by their own distinct `group_key`. */
const RESEARCH_PHASES = ["Research", "Tests", "Decisions"] as const;

/* Custom-property style helper — @types/react has no `--*` index signature, so
 * the object is asserted to CSSProperties (the values are all safe strings). */
function vars(o: Record<string, string | number>): CSSProperties {
  return o as unknown as CSSProperties;
}

/** An in-app target returns its path (so it can open as a workspace tab); an
 *  external target (github, google docs, …) returns null and stays a normal
 *  new-browser-tab link. In-app = a relative path, this app's own origin, or the
 *  production host app.smrtesy.com (the host check is SSR-safe; same-origin is a
 *  fallback for preview domains, evaluated only on the client). */
function toInAppPath(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    const sameOrigin = typeof window !== "undefined" && u.origin === window.location.origin;
    if (u.host === "app.smrtesy.com" || sameOrigin) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* not an absolute URL — treat as external */
  }
  return null;
}

/** Renders a studio deep link. In-app targets open as a NEW workspace tab
 *  (never a new browser window) via OpenTabLink; external targets open in a new
 *  browser tab. `label` is the header of the tab an in-app link opens. */
function StudioLink({
  url,
  label,
  className,
  style,
  children,
}: {
  url: string;
  label: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const locale = useLocale();
  const inApp = toInAppPath(url);
  if (inApp) {
    // OpenTabLink wants a locale-prefixed href; add it unless the path already
    // carries a locale segment.
    const href = /^\/(he|en)(\/|$)/.test(inApp) ? inApp : `/${locale}${inApp}`;
    return (
      <OpenTabLink href={href} label={label} className={className}>
        {children}
      </OpenTabLink>
    );
  }
  return (
    <a className={className} style={style} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/* ── scoped stylesheet (ported from the approved mockup) ─────────────────── */

const CSS = `
.ss-app{
  --h:174;
  --ground:#f6f8fb; --surface:#fff; --surface-2:#eef1f6; --ink:#17202c; --ink-2:#46525f;
  --muted:#6b7686; --line:#e3e8ef; --line-strong:#cfd6e0;
  --accent:#0e9c8e; --accent-ink:#0a5f57; --accent-wash:#e2f4f1;
  --ok:#1f9d57; --ok-wash:#e4f4ea; --warn:#b8791a; --warn-wash:#f7efdd; --crit:#cf4459; --crit-wash:#fbe9ec;
  --shadow:0 1px 2px rgba(20,30,45,.05),0 8px 24px rgba(20,30,45,.06);
  --shadow-lift:0 2px 6px rgba(20,30,45,.08),0 18px 40px rgba(20,30,45,.12);
  --radius:14px; --radius-sm:10px;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif;
  --sat:42%; --lit:44%;
  max-width:1320px;margin-inline:auto;padding:22px clamp(14px,3vw,30px) 48px;direction:ltr;
  background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased;
}
.ss-app *{box-sizing:border-box}

/* dark tokens — OS preference, the app's .dark class, and an explicit override */
@media (prefers-color-scheme:dark){.ss-app{
  --ground:#0c1015; --surface:#151b23; --surface-2:#1c242e; --ink:#e7ecf3; --ink-2:#b3bdca;
  --muted:#8592a2; --line:#242e3a; --line-strong:#33404f;
  --accent:#2fd2be; --accent-ink:#7ff0e2; --accent-wash:#123029;
  --ok:#43cc81; --ok-wash:#12301f; --warn:#e2ac52; --warn-wash:#2c2413; --crit:#f0728a; --crit-wash:#341a20;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.45);
  --shadow-lift:0 2px 6px rgba(0,0,0,.5),0 18px 44px rgba(0,0,0,.6);
  --sat:55%; --lit:62%;
}}
.dark .ss-app,.ss-app[data-theme="dark"]{
  --ground:#0c1015; --surface:#151b23; --surface-2:#1c242e; --ink:#e7ecf3; --ink-2:#b3bdca;
  --muted:#8592a2; --line:#242e3a; --line-strong:#33404f;
  --accent:#2fd2be; --accent-ink:#7ff0e2; --accent-wash:#123029;
  --ok:#43cc81; --ok-wash:#12301f; --warn:#e2ac52; --warn-wash:#2c2413; --crit:#f0728a; --crit-wash:#341a20;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.45);
  --shadow-lift:0 2px 6px rgba(0,0,0,.5),0 18px 44px rgba(0,0,0,.6);
  --sat:55%; --lit:62%;
}
.ss-app[data-theme="light"]{
  --ground:#f6f8fb; --surface:#fff; --surface-2:#eef1f6; --ink:#17202c; --ink-2:#46525f;
  --muted:#6b7686; --line:#e3e8ef; --line-strong:#cfd6e0;
  --accent:#0e9c8e; --accent-ink:#0a5f57; --accent-wash:#e2f4f1;
  --ok:#1f9d57; --ok-wash:#e4f4ea; --warn:#b8791a; --warn-wash:#f7efdd; --crit:#cf4459; --crit-wash:#fbe9ec;
  --shadow:0 1px 2px rgba(20,30,45,.05),0 8px 24px rgba(20,30,45,.06);
  --shadow-lift:0 2px 6px rgba(20,30,45,.08),0 18px 40px rgba(20,30,45,.12);
  --sat:42%; --lit:44%;
}

.ss-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.ss-brand{display:flex;align-items:center;gap:13px}
.ss-title{font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.ss-eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.ss-top-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.ss-overallchip{display:flex;align-items:center;gap:11px;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:7px 8px 7px 15px;box-shadow:var(--shadow)}
.ss-overallchip .lab{font-size:11px;color:var(--muted);font-weight:600}
.ss-ring{--p:0;width:34px;height:34px;border-radius:50%;flex:none;background:conic-gradient(var(--accent) calc(var(--p)*1%),var(--surface-2) 0);display:grid;place-items:center}
.ss-ring span{width:24px;height:24px;border-radius:50%;background:var(--surface);display:grid;place-items:center;font-size:9.5px;font-weight:800;font-family:var(--mono);font-variant-numeric:tabular-nums}

.ss-shell{display:grid;grid-template-columns:minmax(210px,250px) minmax(0,1fr);gap:36px;align-items:start;direction:ltr}
.ss-nav{display:flex;flex-direction:column;gap:8px;position:sticky;top:14px}
.ss-nav-head{display:flex;align-items:baseline;justify-content:space-between;padding:2px 4px 4px}
.ss-nav-head b{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.ss-nav-head .cnt{font-size:11px;color:var(--muted);font-family:var(--mono)}

.ss-tab{--h:200;position:relative;width:100%;text-align:start;cursor:pointer;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:11px 13px;display:grid;grid-template-columns:34px 1fr;gap:11px;align-items:center;color:var(--ink);box-shadow:var(--shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,padding .18s ease}
.ss-tab:hover{border-color:color-mix(in srgb,hsl(var(--h) var(--sat) var(--lit)) 55%,var(--line-strong))}
.ss-tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ss-tab .ic{width:34px;height:34px;border-radius:9px;flex:none;display:grid;place-items:center;color:hsl(var(--h) var(--sat) var(--lit));background:hsl(var(--h) var(--sat) var(--lit)/.13)}
.ss-tab .ic svg{width:19px;height:19px}
.ss-tab .body{min-width:0}
.ss-tab .row1{display:flex;align-items:center;gap:7px}
.ss-tab .idx{font-size:10px;font-weight:800;font-family:var(--mono);color:var(--muted)}
.ss-tab .nm{font-size:13.5px;font-weight:650;letter-spacing:-.01em}
.ss-tab .prog-txt{font-size:10.5px;color:var(--muted);font-family:var(--mono);font-variant-numeric:tabular-nums;margin:5px 0 4px}
.ss-tab .bar{display:none;height:6px;border-radius:999px;background:var(--surface-2);overflow:hidden}
.ss-tab .bar i{display:block;height:100%;border-radius:999px;width:0;transition:width .5s cubic-bezier(.4,0,.2,1)}
.ss-tab .flag{position:absolute;inset-block-start:9px;inset-inline-end:10px;display:none}
.ss-tab .flag svg{width:15px;height:15px}
.ss-tab[data-complete="1"] .flag{display:block;color:var(--ok)}

.ss-tab.active{border-color:hsl(var(--h) var(--sat) var(--lit));padding:20px 17px 22px;box-shadow:var(--shadow-lift),inset 0 0 0 1.5px hsl(var(--h) var(--sat) var(--lit));transform:scale(1.06);z-index:3}
.ss-tab.active .ic{color:#fff;background:hsl(var(--h) var(--sat) var(--lit))}
.ss-tab.active .nm{font-size:15px;font-weight:750}
.ss-tab.active .prog-txt{font-size:12px;color:var(--ink-2);font-weight:650}
.ss-tab.active .bar{display:block;height:8px;margin-top:10px;box-shadow:inset 0 0 0 1px color-mix(in srgb,hsl(var(--h) var(--sat) var(--lit)) 16%,transparent)}
.ss-tab.active .bar i{background:color-mix(in srgb,hsl(var(--h) var(--sat) var(--lit)) 66%,var(--muted))}

.ss-content{min-height:60vh}
.ss-panel-head{margin-bottom:14px}
.ss-panel-head .kick{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:hsl(var(--h) var(--sat) var(--lit));margin-bottom:5px}
.ss-panel-head h2{margin:0;font-size:22px;font-weight:750;letter-spacing:-.02em;text-wrap:balance;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ss-typebadge{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:6px;background:var(--surface-2);color:var(--ink-2)}
.ss-panel-head p{margin:6px 0 0;color:var(--ink-2);font-size:13px;max-width:66ch;line-height:1.55}

.ss-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:14px}
.ss-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 16px 15px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.ss-card::before{content:"";position:absolute;inset-block:0;inset-inline-start:0;width:3px;background:var(--cc,var(--accent));opacity:.4}
.ss-card .ci{width:50px;height:50px;border-radius:13px;display:grid;place-items:center;color:color-mix(in srgb,var(--cc,var(--accent)) 58%,var(--muted));background:color-mix(in srgb,var(--cc,var(--accent)) 10%,transparent);border:1px solid color-mix(in srgb,var(--cc,var(--accent)) 20%,var(--line));margin-bottom:14px}
.ss-card .ci svg{width:26px;height:26px;stroke-width:1.7}
.ss-card .fig{font-size:33px;font-weight:780;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.ss-card .fig small{font-size:16px;font-weight:650;color:var(--muted);letter-spacing:0}
.ss-card .lab{margin-top:8px;font-size:12.5px;color:var(--ink-2);font-weight:600}
.ss-card .sub{margin-top:2px;font-size:11.5px;color:var(--muted);line-height:1.45}

.ss-backrow{margin-bottom:14px}
.ss-back{display:inline-flex;align-items:center;gap:7px;cursor:pointer;background:none;border:none;color:var(--muted);font-size:12.5px;font-weight:600;font-family:var(--sans);padding:4px 2px}
.ss-back:hover{color:var(--accent-ink)}
.ss-back svg{width:15px;height:15px}

.ss-focus{display:grid;gap:18px}
.ss-plan{border:1px solid color-mix(in srgb,hsl(var(--h) var(--sat) var(--lit)) 34%,var(--line));background:color-mix(in srgb,hsl(var(--h) var(--sat) var(--lit)) 6%,var(--surface));border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.ss-plan .pl-head{display:flex;align-items:flex-start;gap:12px}
.ss-plan .pl-ic{width:38px;height:38px;border-radius:10px;flex:none;display:grid;place-items:center;color:#fff;background:hsl(var(--h) var(--sat) var(--lit))}
.ss-plan .pl-ic svg{width:20px;height:20px}
.ss-plan .pl-title{font-size:14px;font-weight:750;display:flex;align-items:center;gap:8px}
.ss-plan .pl-meta{font-size:10px;color:var(--muted);font-family:var(--mono);font-weight:700}
.ss-plan .pl-desc{font-size:12px;color:var(--ink-2);margin-top:3px;line-height:1.5}
.ss-plan .pl-meter{display:flex;gap:10px;margin-top:13px}
.ss-plan .pl-step{flex:1;min-width:0}
.ss-plan .pl-step .seg{height:5px;border-radius:999px;background:var(--surface-2);overflow:hidden}
.ss-plan .pl-step .seg i{display:block;height:100%;width:0;border-radius:999px;background:hsl(var(--h) var(--sat) var(--lit))}
.ss-plan .pl-step[data-st="done"] .seg i{width:100%}
.ss-plan .pl-step[data-st="now"] .seg i{width:50%}
.ss-plan .pl-step .lbl{font-size:9.5px;margin-top:6px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.ss-plan .pl-step[data-st="done"] .lbl,.ss-plan .pl-step[data-st="now"] .lbl{color:var(--ink-2)}
.ss-plan .pl-link{display:inline-flex;align-items:center;gap:5px;margin-top:8px;color:hsl(var(--h) var(--sat) var(--lit));font-size:11px;font-weight:700;text-decoration:none}
.ss-plan .pl-link:hover{text-decoration:underline}
.ss-section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.ss-section.is-empty{opacity:.68}
.ss-section.is-empty>header{border-bottom:0}
.ss-section>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
.ss-section>header .h{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:700;color:hsl(var(--h) var(--sat) var(--lit))}
.ss-section>header .h .dot{width:7px;height:7px;border-radius:50%;background:hsl(var(--h) var(--sat) var(--lit))}
.ss-section>header .h .dot--muted{background:var(--muted)}
.ss-section>header .meta{font-size:11.5px;color:var(--muted);font-family:var(--mono);font-variant-numeric:tabular-nums}

.ss-groups{padding:6px 8px 10px}
.ss-group{padding:8px 8px 4px}
.ss-group + .ss-group{border-top:1px dashed var(--line);margin-top:2px}
.ss-group .g-head{display:flex;align-items:center;gap:9px;padding:6px 4px 4px}
.ss-group .g-idx{width:20px;height:20px;border-radius:6px;flex:none;display:grid;place-items:center;font-size:10px;font-weight:800;font-family:var(--mono);background:var(--surface-2);color:var(--muted)}
.ss-group .g-title{font-size:13px;font-weight:750;letter-spacing:-.01em}
.ss-group .g-meta{margin-inline-start:auto;font-size:10.5px;color:var(--muted);font-family:var(--mono);font-variant-numeric:tabular-nums}
.g-note{font-size:11.5px;color:var(--muted);padding:0 4px 8px 33px;line-height:1.5;margin-top:-2px}
.g-empty{font-size:11.5px;color:var(--muted);padding:2px 8px 8px 39px;font-style:italic;opacity:.75}

.ss-sub{display:grid;grid-template-columns:20px 1fr;gap:11px;padding:8px 8px;border-radius:10px}
.ss-sub .mk{width:20px;height:20px;flex:none;margin-top:1px;display:grid;place-items:center}
.ss-sub .mk svg{width:18px;height:18px}
.ss-sub[data-st="done"] .mk{color:var(--ok)}
.ss-sub[data-st="now"] .mk{color:var(--accent)}
.ss-sub[data-st="todo"] .mk{color:var(--muted)}
.ss-sub .b{min-width:0}
.ss-sub .st-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ss-sub .t{font-size:13px;font-weight:650;letter-spacing:-.01em}
.ss-sub[data-st="done"] .t,.ss-sub[data-st="todo"] .t{color:var(--ink-2)}
.ss-sub .desc{font-size:11.5px;color:var(--muted);line-height:1.5;margin-top:3px}
.ss-sub .lnk{display:inline-flex;align-items:center;gap:5px;margin-top:6px;color:hsl(var(--h) var(--sat) var(--lit));text-decoration:none;font-size:10.5px;font-weight:700;font-family:var(--sans)}
.ss-sub .lnk svg{width:12px;height:12px;flex:none}
.ss-sub .lnk:hover{text-decoration:underline}
.ss-mtag{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:5px}
.ss-mtag.done{color:var(--ok);background:var(--ok-wash)}
.ss-mtag.now{color:var(--accent-ink);background:var(--accent-wash)}
.ss-mtag.todo{color:var(--muted);background:var(--surface-2)}

.ss-chals{padding:12px 14px;display:grid;gap:11px}
.ss-chal{display:grid;grid-template-columns:26px 1fr;gap:11px;padding:12px 13px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}
.ss-chal .sidei{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex:none}
.ss-chal .sidei svg{width:15px;height:15px}
.ss-chal[data-solved="1"]{border-color:color-mix(in srgb,var(--ok) 32%,var(--line))}
.ss-chal[data-solved="1"] .sidei{color:var(--ok);background:var(--ok-wash)}
.ss-chal[data-solved="0"] .sidei{color:var(--crit);background:var(--crit-wash)}
.ss-chal .problem{font-size:13.5px;font-weight:700;letter-spacing:-.01em;line-height:1.35}
.ss-chal .solution{margin-top:4px;font-size:12.5px;color:var(--ink-2);line-height:1.5}
.ss-chal .tag{display:inline-block;margin-inline-start:8px;font-size:9.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:5px;vertical-align:middle}
.ss-chal[data-solved="1"] .tag{color:var(--ok);background:var(--ok-wash)}

.ss-outs{padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.ss-out{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--surface)}
.ss-out .thumb{width:38px;height:38px;border-radius:8px;flex:none;display:grid;place-items:center;color:var(--oc);background:color-mix(in srgb,var(--oc) 13%,transparent);border:1px solid color-mix(in srgb,var(--oc) 22%,var(--line))}
.ss-out .thumb svg{width:20px;height:20px}
.ss-out .ol{min-width:0;display:flex;flex-direction:column;line-height:1.3}
.ss-out .ol b{font-size:12.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-out .ol span{font-size:11px;color:var(--muted)}

@media (max-width:560px){
  .ss-shell{grid-template-columns:1fr}
  .ss-nav{position:static;flex-direction:row;overflow-x:auto;padding-bottom:6px;gap:10px}
  .ss-nav-head{display:none}
  .ss-tab{width:180px;flex:none;grid-template-columns:30px 1fr}
  .ss-tab.active{transform:none}
}
@media (prefers-reduced-motion:reduce){.ss-app *{transition:none!important}}
`;

/* ── small building blocks ───────────────────────────────────────────────── */

function Svg({ paths, className }: { paths: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}

type Group = { key: string; note: string; order: number; items: StudioItem[] };

/** Fold a build stage's flat items into distinct groups, ordered by group_order. */
function groupItems(items: StudioItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const it of items) {
    let g = map.get(it.group_key);
    if (!g) {
      g = { key: it.group_key, note: it.group_note, order: it.group_order, items: [] };
      map.set(it.group_key, g);
    }
    g.items.push(it);
  }
  return Array.from(map.values()).sort((a, b) => a.order - b.order);
}

function TaskRow({ item }: { item: StudioItem }) {
  const m = ST_META[item.status] ?? ST_META.todo;
  return (
    <div className="ss-sub" data-st={item.status}>
      <span className="mk">
        <Svg paths={ICON[m.ic]} />
      </span>
      <span className="b">
        <span className="st-row">
          <span className="t">{item.title}</span>
          <span className={`ss-mtag ${item.status}`}>{m.tag}</span>
        </span>
        <span className="desc">{item.desc}</span>
        {item.link_url ? (
          <StudioLink className="lnk" url={item.link_url} label={item.link_label || item.title}>
            <Svg paths={ICON.doc} />
            {item.link_label || "link"} ↗
          </StudioLink>
        ) : null}
      </span>
    </div>
  );
}

/** Tasks & status body: fixed phases for research stages, distinct groups for
 *  build stages. */
function TaskGroups({ stage }: { stage: StudioStage }) {
  if (stage.kind === "research") {
    return (
      <>
        {RESEARCH_PHASES.map((phase, gi) => {
          // Match case-insensitively: the seed stores the phase group_key in
          // lower case ('research'/'tests'/'decisions') while the display labels
          // here are title-cased, so a `===` compare would drop every row.
          const subs = stage.items.filter(
            (x) => x.group_key.toLowerCase() === phase.toLowerCase(),
          );
          const done = subs.filter((s) => s.status === "done").length;
          return (
            <div className="ss-group" key={phase}>
              <div className="g-head">
                <span className="g-idx">{gi + 1}</span>
                <span className="g-title">{phase}</span>
                <span className="g-meta">{subs.length ? `${done}/${subs.length}` : "—"}</span>
              </div>
              {subs.length ? (
                subs.map((it) => <TaskRow key={`${phase}-${it.title}`} item={it} />)
              ) : (
                <div className="g-empty">Nothing defined here yet</div>
              )}
            </div>
          );
        })}
      </>
    );
  }
  return (
    <>
      {groupItems(stage.items).map((g, i) => {
        const done = g.items.filter((s) => s.status === "done").length;
        return (
          <div className="ss-group" key={g.key}>
            <div className="g-head">
              <span className="g-idx">{i + 1}</span>
              <span className="g-title">{g.key}</span>
              <span className="g-meta">
                {done}/{g.items.length}
              </span>
            </div>
            {g.note ? <div className="g-note">{g.note}</div> : null}
            {g.items.map((it) => (
              <TaskRow key={`${g.key}-${it.title}`} item={it} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function PlanCard({ stage }: { stage: StudioStage }) {
  const p = stage.plan;
  const steps: [string, StudioStatus][] = [
    ["General draft", p.general],
    ["Detail", p.detail],
    ["Verify ×2 sources", p.verify],
  ];
  const done = steps.filter(([, s]) => s === "done").length;
  return (
    <div className="ss-plan">
      <div className="pl-head">
        <span className="pl-ic">
          <Svg paths={ICON.planning} />
        </span>
        <div className="pl-body">
          <div className="pl-title">
            Plan <span className="pl-meta">{done}/3 steps</span>
          </div>
          <div className="pl-desc">{p.desc}</div>
          {p.smrtplan_url ? (
            <StudioLink className="pl-link" url={p.smrtplan_url} label="smrtPlan">
              Open plan in smrtPlan ↗
            </StudioLink>
          ) : null}
        </div>
      </div>
      <div className="pl-meter">
        {steps.map(([label, s]) => (
          <div className="pl-step" data-st={s} key={label}>
            <div className="seg">
              <i />
            </div>
            <div className="lbl">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FocusView({
  stage,
  index,
  onBack,
}: {
  stage: StudioStage;
  index: number;
  onBack: () => void;
}) {
  const solvedCount = stage.challenges.filter((c) => c.solved).length;
  return (
    <>
      <div className="ss-backrow">
        <button className="ss-back" type="button" onClick={onBack}>
          <Svg paths={ICON.back} /> Back to dashboard
        </button>
      </div>
      <div className="ss-panel-head">
        <div className="kick">
          Stage {String(index).padStart(2, "0")} · {stage.done} of {stage.total} done · {stage.pct}%
        </div>
        <h2>
          {stage.name}{" "}
          <span className="ss-typebadge">{stage.kind === "research" ? "Research" : "Build"}</span>
        </h2>
        <p>{stage.blurb}</p>
      </div>

      <div className="ss-focus">
        <PlanCard stage={stage} />

        <section className="ss-section">
          <header>
            <span className="h">
              <span className="dot" />
              Tasks &amp; status
            </span>
          </header>
          <div className="ss-groups">
            <TaskGroups stage={stage} />
          </div>
        </section>

        {stage.challenges.length > 0 && (
          <section className="ss-section">
            <header>
              <span className="h">
                <span className="dot" />
                Expected challenges
              </span>
              <span className="meta">
                {solvedCount} of {stage.challenges.length} solved
              </span>
            </header>
            <div className="ss-chals">
              {stage.challenges.map((c) => {
                const solved = c.solved;
                return (
                  <div className="ss-chal" data-solved={solved ? "1" : "0"} key={c.problem}>
                    <span className="sidei">
                      <Svg paths={solved ? ICON.check : ICON.alert} />
                    </span>
                    <div>
                      <div className="problem">
                        {c.problem}
                        {solved && <span className="tag">Solved</span>}
                      </div>
                      {solved && c.solution && <div className="solution">{c.solution}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {stage.outputs.length > 0 ? (
          <section className="ss-section">
            <header>
              <span className="h">
                <span className="dot" />
                Outputs
              </span>
              <span className="meta">
                {stage.outputs.length}
                {stage.outputs.length > 1 ? " items" : " item"}
              </span>
            </header>
            <div className="ss-outs">
              {stage.outputs.map((o, i) => {
                const k = OUT_KIND[o.kind] ?? OUT_KIND.text;
                const inner = (
                  <>
                    <span className="thumb" style={vars({ "--oc": k.c })}>
                      <Svg paths={ICON[k.icon]} />
                    </span>
                    <span className="ol">
                      <b>{o.label}</b>
                      <span>{o.meta}</span>
                    </span>
                  </>
                );
                return o.link_url ? (
                  <StudioLink
                    className="ss-out"
                    url={o.link_url}
                    label={o.label}
                    style={{ textDecoration: "none", color: "inherit" }}
                    key={`${o.label}-${i}`}
                  >
                    {inner}
                  </StudioLink>
                ) : (
                  <div className="ss-out" key={`${o.label}-${i}`}>
                    {inner}
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="ss-section is-empty">
            <header>
              <span className="h">
                <span className="dot dot--muted" />
                Outputs
              </span>
              <span className="meta">No outputs yet</span>
            </header>
          </section>
        )}
      </div>
    </>
  );
}

function Dashboard({ overview }: { overview: StudioOverview }) {
  const s = computeStats(overview);
  const cards: { ic: string; cc: string; fig: ReactNode; lab: string; sub: string }[] = [
    {
      ic: "shield",
      cc: "var(--ok)",
      fig: (
        <>
          {s.complete}
          <small> / {s.stageCount}</small>
        </>
      ),
      lab: "Stages complete",
      sub: "Fully settled and locked",
    },
    {
      ic: "trend",
      cc: "var(--accent)",
      fig: (
        <>
          {s.overallPct}
          <small>%</small>
        </>
      ),
      lab: "Overall progress",
      sub: "Across every build stage",
    },
    {
      ic: "checklist",
      cc: "#3a63c9",
      fig: (
        <>
          {s.sumDone}
          <small> / {s.sumTotal}</small>
        </>
      ),
      lab: "Sub-tasks done",
      sub: "Across all stages",
    },
    {
      ic: "check",
      cc: "var(--ok)",
      fig: (
        <>
          {s.chalSolved}
          <small> / {s.chalTotal}</small>
        </>
      ),
      lab: "Challenges solved",
      sub: "Mapped problems with an answer",
    },
    {
      ic: "play",
      cc: "hsl(44 var(--sat) var(--lit))",
      fig: s.active,
      lab: "Active stage",
      sub: "Where the work is now",
    },
    {
      ic: "db",
      cc: "#7a52c9",
      fig: overview.models_total.toLocaleString("en-US"),
      lab: "Models researched",
      sub: "AI endpoints indexed",
    },
    {
      ic: "tool",
      cc: "var(--warn)",
      fig: String(s.toolsCount),
      lab: "Tools in build",
      sub: s.toolsSub,
    },
  ];
  return (
    <>
      <div className="ss-panel-head">
        <div className="kick">Dashboard</div>
        <h2>Pipeline build at a glance</h2>
        <p>
          How far along we are in planning and building the production pipeline. Pick a stage on the
          left to open its tasks, challenges and outputs.
        </p>
      </div>
      <div className="ss-stats">
        {cards.map((c) => (
          <div className="ss-card" style={vars({ "--cc": c.cc })} key={c.lab}>
            <div className="ci">
              <Svg paths={ICON[c.ic] ?? ICON.sets} />
            </div>
            <div className="fig">{c.fig}</div>
            <div className="lab">{c.lab}</div>
            <div className="sub">{c.sub}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── derived headline numbers ────────────────────────────────────────────── */

function computeStats(ov: StudioOverview) {
  let complete = 0;
  let sumDone = 0;
  let sumTotal = 0;
  let chalSolved = 0;
  let chalTotal = 0;
  let active = "—";
  for (const st of ov.stages) {
    if (st.pct === 100) complete += 1;
    sumDone += st.done;
    sumTotal += st.total;
    for (const c of st.challenges) {
      chalTotal += 1;
      if (c.solved) chalSolved += 1;
    }
    if (active === "—" && st.pct > 0 && st.pct < 100) active = st.name;
  }
  const buildGroups = ov.stages
    .filter((x) => x.kind === "build")
    .flatMap((x) => groupItems(x.items));
  return {
    complete,
    sumDone,
    sumTotal,
    chalSolved,
    chalTotal,
    active,
    overallPct: sumTotal ? Math.round((sumDone / sumTotal) * 100) : 0,
    stageCount: ov.stages.length,
    toolsCount: buildGroups.length,
    toolsSub: buildGroups.map((g) => g.key).join(" · ") || "—",
  };
}

/* ── the console ─────────────────────────────────────────────────────────── */

export function StudioConsole() {
  const [overview, setOverview] = useState<StudioOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const o = await api<StudioOverview>("/api/studio/overview");
      setOverview(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) {
    return (
      <div className="mx-auto max-w-[1320px] p-4 sm:p-6">
        <Skeleton className="mb-5 h-9 w-72" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(210px,250px)_1fr]">
          <div className="grid gap-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1320px] p-4 sm:p-6">
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-semibold">Could not load the studio console</p>
          <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          <button
            type="button"
            className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!overview) return null;

  const stages = overview.stages;
  const selectedStage = selected ? stages.find((s) => s.slug === selected) ?? null : null;
  const overallPct = computeStats(overview).overallPct;

  return (
    <div className="ss-app" dir="ltr">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="ss-top">
        <div className="ss-brand">
          <div>
            <div className="ss-eyebrow">Operator Console</div>
            <div className="ss-title">Smart Studio · Build Tracker</div>
          </div>
        </div>
        <div className="ss-top-right">
          <div className="ss-overallchip" title="Overall build progress">
            <span className="lab">Overall progress</span>
            <span className="ss-ring" style={vars({ "--p": overallPct })}>
              <span>{overallPct}%</span>
            </span>
          </div>
        </div>
      </div>

      <div className="ss-shell">
        <nav className="ss-nav" aria-label="Build stages">
          <div className="ss-nav-head">
            <b>Build stages</b>
            <span className="cnt">{stages.length} stages</span>
          </div>
          {stages.map((st, i) => {
            const isActive = st.slug === selected;
            return (
              <button
                key={st.slug}
                type="button"
                className={`ss-tab${isActive ? " active" : ""}`}
                style={vars({ "--h": st.hue })}
                data-complete={st.pct === 100 ? "1" : "0"}
                onClick={() => setSelected(st.slug)}
              >
                <span className="flag">
                  <Svg paths={ICON.cdone} />
                </span>
                <span className="ic">
                  <Svg paths={ICON[st.slug] ?? ICON.sets} />
                </span>
                <span className="body">
                  <span className="row1">
                    <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                    <span className="nm">{st.name}</span>
                  </span>
                  <span className="prog-txt">
                    {st.done} of {st.total} done · {st.pct}%
                  </span>
                  <span className="bar">
                    <i style={isActive ? { width: `${st.pct}%` } : undefined} />
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <main
          className="ss-content"
          style={selectedStage ? vars({ "--h": selectedStage.hue }) : undefined}
        >
          {selectedStage ? (
            <FocusView
              stage={selectedStage}
              index={stages.indexOf(selectedStage) + 1}
              onBack={() => setSelected(null)}
            />
          ) : (
            <Dashboard overview={overview} />
          )}
        </main>
      </div>
    </div>
  );
}
