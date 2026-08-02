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

const MAX_SESSIONS = 4; // host guard — a few concurrent signups, not a fleet
const IDLE_TIMEOUT_MS = 10 * 60_000; // auto-close a session left idle 10 min
const NAV_TIMEOUT_MS = 60_000;

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
 * A server-side browser is an SSRF surface: left open it could be pointed at
 * `http://169.254.169.254/…` (cloud metadata) or the backend's own internal
 * services. We allow only http(s) to a PUBLIC host — literal-blocking loopback,
 * private, link-local and metadata addresses, plus `localhost`/`*.local`. (This
 * catches the common cases; it does not defeat DNS-rebinding, which a future
 * hardening can address by pinning the resolved IP.)
 */
function isSafePublicUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  // IPv4 literal ranges
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
      return null;
  }
  // IPv6 loopback / link-local / unique-local
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return null;
  return u;
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
 *  null when the id is unknown OR belongs to a different user (never leak). */
export function getOwnedSession(id: string, userId: string): WebSession | null {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) return null;
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

export async function createSession(userId: string, orgId: string): Promise<SessionInfo> {
  // Reap the oldest idle session first if we're at the cap.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) await closeSession(oldest.id, oldest.userId);
  }
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
