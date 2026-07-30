/**
 * Browser helper for Claude runs — "Claude uses the app like a user".
 *
 * A STANDALONE CLI, not part of the server process: the runner injects
 * SMRTESY_BROWSER_HELPER (the compiled path of this file) into a run's
 * environment, and the run's agent invokes it with `node`. It launches a
 * headless Chromium on this host (the same binary the admin domain-tracker
 * uses), logs it into the Next.js app as the launching user by installing the
 * session cookies minted in app-access.ts, and then does what the agent asked:
 *
 *   node $SMRTESY_BROWSER_HELPER shot /he/tasks --out tasks.png [--full] [--wait <css>] [--attach]
 *       open a screen, screenshot it; --attach posts the image back into the
 *       chat turn so the user sees what the run saw.
 *   node $SMRTESY_BROWSER_HELPER text /he/tasks [--selector <css>]
 *       print the rendered text of a screen (or one element) for inspection.
 *   node $SMRTESY_BROWSER_HELPER run check.mjs
 *       full Playwright control: the script's default export runs with
 *       { browser, context, page, appUrl, goto, shot, log } — no playwright
 *       import needed in the script (it resolves only from the server's own
 *       node_modules, which a run workspace does not see).
 *
 * This file lives beside the rest of the claude module so `require("playwright")`
 * resolves from server/node_modules regardless of the run's working directory.
 * Everything here is best-effort against a live app: failures print a clear,
 * actionable message and exit non-zero — they must never look like success.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";

interface HelperCtx {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  appUrl: string;
  goto: (target: string) => Promise<void>;
  shot: (name?: string, opts?: { full?: boolean; attach?: boolean }) => Promise<string>;
  log: (...args: unknown[]) => void;
}

/** Console/page errors collected during the session — printed at the end so a
 *  verification run also reports what the browser itself complained about. */
const pageProblems: string[] = [];

/** The launched browser, module-level so EVERY exit path can close it — the
 *  watchdog and main().catch fire outside the scope that launched it, and a
 *  process.exit that skips close leaves a zombie Chromium on the host. */
let activeBrowser: Browser | null = null;

async function closeBrowser(): Promise<void> {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  node $SMRTESY_BROWSER_HELPER shot <path|url> [--out file.png] [--full] [--wait <css>] [--attach] [--timeout <sec>]",
      "  node $SMRTESY_BROWSER_HELPER text <path|url> [--selector <css>] [--timeout <sec>]",
      "  node $SMRTESY_BROWSER_HELPER run <script.mjs> [--timeout <sec>]",
    ].join("\n"),
  );
  process.exit(2);
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function opt(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** Resolve a target to a full URL: absolute URLs pass through; anything else is
 *  a path on the app (so agents write "/he/tasks", not the whole origin). */
function resolveTarget(appUrl: string, target: string): string {
  if (/^https?:\/\//.test(target)) return target;
  return appUrl.replace(/\/+$/, "") + (target.startsWith("/") ? target : `/${target}`);
}

async function attachToChat(file: string, mime: string): Promise<void> {
  const apiUrl = process.env.SMRTESY_API_URL;
  const token = process.env.SMRTESY_API_TOKEN;
  const orgId = process.env.SMRTESY_ORG_ID;
  const runId = process.env.SMRTESY_RUN_ID;
  if (!apiUrl || !token || !runId) {
    console.error("[attach] skipped: SMRTESY_API_URL / SMRTESY_API_TOKEN / SMRTESY_RUN_ID not set");
    return;
  }
  const bytes = await readFile(file);
  const res = await fetch(`${apiUrl}/api/claude/runs/${runId}/attachments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(orgId ? { "X-Org-Id": orgId } : {}),
    },
    body: JSON.stringify({
      filename: path.basename(file),
      mime_type: mime,
      base64: bytes.toString("base64"),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[attach] failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    return;
  }
  console.log(`[attach] ${path.basename(file)} posted to the chat turn`);
}

async function openSession(): Promise<{ browser: Browser; context: BrowserContext; page: Page; appUrl: string }> {
  const appUrl = (process.env.SMRTESY_APP_URL ?? "").replace(/\/+$/, "");
  const cookiesJson = process.env.SMRTESY_BROWSER_COOKIES;
  if (!appUrl || !cookiesJson) {
    console.error(
      "browser access is not available in this run: SMRTESY_APP_URL / SMRTESY_BROWSER_COOKIES are not set. " +
        "This usually means the backend could not resolve the app frontend URL (FRONTEND_URL / SMRTESY_APP_URL).",
    );
    process.exit(3);
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = require("playwright") as typeof import("playwright"));
  } catch {
    console.error("playwright is not installed on this server — browser access unavailable.");
    process.exit(3);
  }

  let browser: Browser;
  try {
    // Launch args mirror the admin domain-tracker (server/src/modules/admin/
    // domain-tracker.ts) — the set proven to work in this Railway container.
    // SMRTESY_CHROMIUM_PATH overrides the binary for hosts where the browser
    // is preinstalled at a fixed path instead of playwright's versioned cache.
    browser = await chromium.launch({
      ...(process.env.SMRTESY_CHROMIUM_PATH ? { executablePath: process.env.SMRTESY_CHROMIUM_PATH } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-accelerated-2d-canvas",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--mute-audio",
      ],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
      console.error(
        "Chromium is not installed on this server (set INSTALL_CHROMIUM=1 on the backend service and redeploy). " +
          "Browser access unavailable; the SMRTESY_API_* curl route still works.",
      );
      process.exit(3);
    }
    throw e;
  }

  activeBrowser = browser;

  // From here on the browser is live: any setup failure (bad cookies JSON,
  // context/page creation) must close it on the way out or it outlives us.
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cookies = JSON.parse(cookiesJson) as { name: string; value: string }[];
    await context.addCookies(cookies.map((c) => ({ ...c, url: appUrl })));

    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") pageProblems.push(`console.error: ${msg.text().slice(0, 500)}`);
    });
    page.on("pageerror", (err) => pageProblems.push(`pageerror: ${String(err).slice(0, 500)}`));

    return { browser, context, page, appUrl };
  } catch (e) {
    await closeBrowser();
    throw e;
  }
}

async function gotoTarget(page: Page, appUrl: string, target: string): Promise<void> {
  const url = resolveTarget(appUrl, target);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // SPAs with polling/realtime often never reach networkidle — treat it as a
  // best-effort settle, not a requirement.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

function reportProblems(page: Page): void {
  console.log(`final url: ${page.url()}`);
  if (pageProblems.length === 0) {
    console.log("browser console: clean (no errors)");
  } else {
    console.log(`browser console: ${pageProblems.length} error(s):`);
    for (const p of pageProblems.slice(0, 20)) console.log(`  - ${p}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd || !["shot", "text", "run"].includes(cmd)) usage();

  const timeoutSec = Number(opt(args, "--timeout")) || 120;
  const killer = setTimeout(() => {
    console.error(`browser helper timed out after ${timeoutSec}s`);
    // A wedged browser can hang close() too — the second timer guarantees the
    // exit; process death reaps the child either way.
    setTimeout(() => process.exit(124), 5_000).unref();
    void closeBrowser().finally(() => process.exit(124));
  }, timeoutSec * 1000);
  killer.unref();

  const { browser, context, page, appUrl } = await openSession();

  const shot = async (name?: string, o?: { full?: boolean; attach?: boolean }): Promise<string> => {
    // basename() confines the file to the working directory — the run may write
    // there anyway, but --out must not become an arbitrary-path write primitive.
    const file = path.resolve(path.basename(name || "screenshot.png"));
    await page.screenshot({ path: file, fullPage: o?.full ?? false });
    console.log(`screenshot saved: ${file}`);
    if (o?.attach) await attachToChat(file, "image/png");
    return file;
  };

  try {
    if (cmd === "shot") {
      const target = args.shift();
      if (!target) usage();
      const out = opt(args, "--out") || "screenshot.png";
      const wait = opt(args, "--wait");
      const full = flag(args, "--full");
      const attach = flag(args, "--attach");
      await gotoTarget(page, appUrl, target);
      if (wait) await page.waitForSelector(wait, { timeout: 20_000 });
      await shot(out, { full, attach });
      reportProblems(page);
    } else if (cmd === "text") {
      const target = args.shift();
      if (!target) usage();
      const selector = opt(args, "--selector");
      await gotoTarget(page, appUrl, target);
      const text = selector
        ? await page.locator(selector).first().innerText({ timeout: 20_000 })
        : await page.locator("body").innerText({ timeout: 20_000 });
      console.log(text.trim().slice(0, 20_000));
      reportProblems(page);
    } else {
      const scriptPath = args.shift();
      if (!scriptPath) usage();
      // A REAL dynamic import, not the require() tsc lowers `import()` to under
      // module=commonjs — require cannot load the .mjs scripts agents write.
      const dynamicImport = new Function("p", "return import(p)") as (p: string) => Promise<Record<string, unknown>>;
      const mod = await dynamicImport(pathToFileURL(path.resolve(scriptPath)).href);
      const fn = mod.default;
      if (typeof fn !== "function") {
        throw new Error(`${scriptPath} must have a default export: export default async ({ page, goto, shot, ... }) => { ... }`);
      }
      const ctx: HelperCtx = {
        browser,
        context,
        page,
        appUrl,
        goto: (t: string) => gotoTarget(page, appUrl, t),
        shot,
        log: (...a: unknown[]) => console.log(...a),
      };
      await fn(ctx);
      reportProblems(page);
    }
  } catch (e) {
    reportProblems(page);
    console.error("browser helper failed:", e instanceof Error ? e.message : String(e));
    await closeBrowser();
    process.exit(1);
  }

  await closeBrowser();
}

if (require.main === module) {
  void main().catch(async (e) => {
    console.error("browser helper failed:", e instanceof Error ? e.message : String(e));
    // Covers failures between launch and the command try/catch (e.g. cookie
    // setup) — without this close a crashed helper strands its Chromium.
    await closeBrowser();
    process.exit(1);
  });
}

// Exported for tests / reuse; harmless when the file is run as a CLI.
export { resolveTarget };
