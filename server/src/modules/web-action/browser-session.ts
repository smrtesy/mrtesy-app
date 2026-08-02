/**
 * web-action — live browser session manager (backend-hosted).
 *
 * The Claude Code container is ephemeral and not inbound-reachable, so an
 * interactive live-view can't live there. This runs a real Chromium session on
 * the BACKEND (Railway — already has Chromium, already public), driven by the
 * agent over the REST routes and mirrored to an authenticated app screen via CDP
 * screencast (live-view, added separately). Chromium stays HEADLESS: CDP
 * `Page.startScreencast` + `Input.dispatch*` give an interactive stream with no
 * X display needed, so the user can grab control for a CAPTCHA in place.
 *
 * SECURITY: a session is owned by the (userId, orgId) that created it and can be
 * controlled by no one else. Sessions are capped and idle-swept so a forgotten
 * browser can't pile up on the host. This module NEVER logs page content, form
 * values, or extracted secrets.
 */

import { randomUUID } from "crypto";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

export interface WebSession {
  id: string;
  userId: string;
  orgId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  /** Console/page errors seen on this session — surfaced, never the page text. */
  problems: string[];
  /** Lazily-created CDP session for the live-view (screencast + input relay). */
  cdp?: CDPSession;
}

/** Get (or lazily open) the page's CDP session — used by the live-view for
 *  screencast frames and for dispatching the user's mouse/keyboard. Bound to the
 *  page target, so it survives same-page navigations. */
export async function getCdp(s: WebSession): Promise<CDPSession> {
  if (!s.cdp) s.cdp = await s.context.newCDPSession(s.page);
  return s.cdp;
}

const sessions = new Map<string, WebSession>();

const MAX_SESSIONS_PER_USER = 2; // one user shouldn't hold a fleet
const MAX_SESSIONS_GLOBAL = 8; // host guard across all users
// Human-in-the-loop flows (relay an email/SMS code, solve a CAPTCHA, provide a
// form value) routinely idle for several minutes between agent actions while the
// user does their part — 10 min was too short and kept closing live signups
// mid-flow. 30 min comfortably covers a relay without letting a truly abandoned
// browser linger too long.
const IDLE_TIMEOUT_MS = 30 * 60_000;
const NAV_TIMEOUT_MS = 60_000;

/** Raised when a caller is at their session limit — the route maps it to 429. */
export class SessionLimitError extends Error {
  readonly code = "SESSION_LIMIT";
}

// Same arg set the domain-tracker / browser-helper prove works in the Railway
// container. SMRTESY_CHROMIUM_PATH overrides the binary where it is preinstalled.
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--disable-extensions",
  "--mute-audio",
  "--no-first-run",
];

/**
 * A server-side browser is an SSRF surface: it could be pointed at
 * `http://169.254.169.254/…` (cloud metadata) or the backend's own internal
 * services — directly OR via a redirect / in-page navigation. We literal-block
 * loopback, private, link-local and metadata hosts. (Catches the common cases;
 * does not defeat DNS-rebinding — a hostname that resolves to a private IP —
 * which a future hardening can close by pinning the resolved IP.)
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local + cloud metadata
      a === 0
    )
      return true;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

/** Only http(s) to a PUBLIC host is a valid navigate target. */
function isSafePublicUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  return isPrivateHost(u.hostname) ? null : u;
}

/**
 * Install a request filter that ABORTS any http(s) request to a private host —
 * on the initial nav AND on every redirect, subresource, XHR, and JS
 * navigation. This is the real SSRF enforcement point (gating only the first
 * URL is bypassable via a 302 to an internal address). Non-http schemes
 * (about:, data:, blob:) pass through untouched so the page still works.
 */
async function installSsrfGuard(context: BrowserContext): Promise<void> {
  await context.route("**", (route) => {
    let privateTarget = false;
    try {
      const u = new URL(route.request().url());
      privateTarget = ["http:", "https:"].includes(u.protocol) && isPrivateHost(u.hostname);
    } catch {
      /* non-URL request — let it through */
    }
    if (privateTarget) return route.abort("blockedbyclient");
    return route.continue();
  });
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({
    headless: true,
    ...(process.env.SMRTESY_CHROMIUM_PATH ? { executablePath: process.env.SMRTESY_CHROMIUM_PATH } : {}),
    args: LAUNCH_ARGS,
  });
}

/** Owner-scoped lookup — the ONLY way a route reaches a live session. Returns
 *  null when the id is unknown OR belongs to a different user/org (never leak,
 *  and never let a multi-org user drive a session — or bank its extracted secret
 *  — under a different active org than the one it was created in). */
export function getOwnedSession(id: string, userId: string, orgId: string): WebSession | null {
  const s = sessions.get(id);
  if (!s || s.userId !== userId || s.orgId !== orgId) return null;
  s.lastUsedAt = Date.now();
  return s;
}

export interface SessionInfo {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  problems: string[];
}

async function info(s: WebSession): Promise<SessionInfo> {
  return {
    id: s.id,
    url: s.page.url(),
    title: await s.page.title().catch(() => ""),
    createdAt: s.createdAt,
    problems: [...s.problems],
  };
}

/** Reap the caller's OWN oldest idle session, or throw if they're at the cap
 *  with nothing idle. NEVER evicts another user's session (that was a DoS + a
 *  way to kill a stranger's in-progress signup). */
function enforceCaps(userId: string): Promise<void> | void {
  const now = Date.now();
  const reapOwnIdle = async (): Promise<boolean> => {
    const idle = [...sessions.values()]
      .filter((s) => s.userId === userId && now - s.lastUsedAt > IDLE_TIMEOUT_MS)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) return false;
    await closeSession(idle.id, idle.userId);
    return true;
  };
  const mine = [...sessions.values()].filter((s) => s.userId === userId).length;
  if (mine >= MAX_SESSIONS_PER_USER) {
    return reapOwnIdle().then((freed) => {
      if (!freed) throw new SessionLimitError("session limit reached — close an existing session first");
    });
  }
  if (sessions.size >= MAX_SESSIONS_GLOBAL) {
    return reapOwnIdle().then((freed) => {
      if (!freed) throw new SessionLimitError("host is at capacity — try again shortly");
    });
  }
}

export async function createSession(userId: string, orgId: string): Promise<SessionInfo> {
  await enforceCaps(userId);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installSsrfGuard(context);
  const page = await context.newPage();
  const s: WebSession = {
    id: randomUUID(),
    userId,
    orgId,
    browser,
    context,
    page,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    problems: [],
  };
  page.on("console", (m) => {
    if (m.type() === "error") s.problems.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => s.problems.push(`pageerror: ${String(e).slice(0, 300)}`));
  sessions.set(s.id, s);
  return info(s);
}

export async function navigate(s: WebSession, rawUrl: string): Promise<SessionInfo> {
  const url = isSafePublicUrl(rawUrl);
  if (!url) throw new Error("navigate: url must be http(s) to a public host");
  await s.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  return info(s);
}

export type ActionType = "click" | "fill" | "press" | "wait_for";

export interface Action {
  type: ActionType;
  selector?: string;
  text?: string;
  key?: string;
  /** ms for wait_for */
  timeout?: number;
}

/**
 * A single driving action. Selectors go through Playwright's auto-waiting, so a
 * not-yet-rendered target fails cleanly instead of racing. Errors surface to the
 * caller — a failed action must never look like a success.
 */
export async function act(s: WebSession, a: Action): Promise<SessionInfo> {
  switch (a.type) {
    case "click":
      if (!a.selector) throw new Error("click: selector required");
      await s.page.locator(a.selector).first().click({ timeout: 15_000 });
      break;
    case "fill":
      if (!a.selector) throw new Error("fill: selector required");
      await s.page.locator(a.selector).first().fill(a.text ?? "", { timeout: 15_000 });
      break;
    case "press":
      await s.page.keyboard.press(a.key || "Enter");
      break;
    case "wait_for":
      if (!a.selector) throw new Error("wait_for: selector required");
      await s.page.locator(a.selector).first().waitFor({ state: "visible", timeout: a.timeout ?? 15_000 });
      break;
    default:
      throw new Error(`unknown action type: ${(a as Action).type}`);
  }
  return info(s);
}

/** PNG screenshot as a base64 data URL — for the agent to "see" the page and for
 *  the still-frame fallback when the live-view socket isn't open. */
export async function screenshotDataUrl(s: WebSession, fullPage = false): Promise<string> {
  const buf = await s.page.screenshot({ fullPage, type: "png" });
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export async function closeSession(id: string, userId: string): Promise<boolean> {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return false;
  sessions.delete(id);
  await s.browser.close().catch(() => {});
  return true;
}

export async function listSessions(userId: string): Promise<SessionInfo[]> {
  return Promise.all([...sessions.values()].filter((s) => s.userId === userId).map(info));
}

// ── idle sweeper ──────────────────────────────────────────────────────────────
// A signup the user walked away from must not hold a browser forever.
let sweeper: NodeJS.Timeout | null = null;
export function startIdleSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (now - s.lastUsedAt > IDLE_TIMEOUT_MS) void closeSession(s.id, s.userId);
    }
  }, 60_000);
  sweeper.unref?.();
}
