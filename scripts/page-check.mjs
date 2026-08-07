#!/usr/bin/env node
/**
 * page-check — drive a CHANGED screen in a real browser, like a user.
 *
 * The pre-push protocol's build + greps + sub-agent review are all STATIC. This
 * is the runtime gate: it boots the *changed* branch locally (`next dev`) — the
 * live app runs old `main`, so only a local run reflects the change — logs in as
 * the real user (a session minted by the backend), opens the screen in the
 * pre-installed Chromium, runs a full interaction scenario, and reports every
 * console error / page error / failed request it saw. Exit 0 = pass, non-0 = fail.
 *
 * Usage:
 *   node scripts/page-check.mjs <path> [--scenario <file.mjs>] [--port N]
 *                               [--no-auth] [--user-email <e>] [--out <dir>] [--keep]
 *   node scripts/page-check.mjs /he/tasks --scenario .claude/page-checks/tasks.mjs
 *
 * Env it reads (all already present in a Claude Code web session):
 *   SMRTESY_BACKEND_URL, SMRTBOT_INTERNAL_SECRET, SMRTTASK_USER_ID
 *   SMRTESY_CHROMIUM_PATH (optional; defaults to /opt/pw-browsers/chromium)
 *
 * --no-auth skips the session mint and uses the frontend's dev-bypass instead —
 * good for a pure render/UI check, but backend API calls will 401, so
 * data-driven screens will show errors. Prefer the default (real session).
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROMIUM = process.env.SMRTESY_CHROMIUM_PATH || "/opt/pw-browsers/chromium";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i === argv.length - 1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}
const scenarioPath = opt("--scenario");
const port = parseInt(opt("--port", "3100"), 10);
const noAuth = flag("--no-auth");
const userEmail = opt("--user-email");
const keep = flag("--keep");
const outDir = path.resolve(opt("--out", path.join(REPO_ROOT, ".page-check")));
const targetPath = (argv[0] || "/he/tasks").startsWith("/") ? argv[0] || "/he/tasks" : `/${argv[0]}`;
const baseUrl = `http://localhost:${port}`;

const problems = [];
const logs = [];
function log(...a) {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logs.push(line);
  console.log(line);
}
function fail(msg) {
  console.error(`\n✗ page-check FAILED: ${msg}\n`);
  process.exitCode = 1;
}

// ── 1. get a real session + public config from the backend ────────────────────
async function fetchAppAccess() {
  const backend = (process.env.SMRTESY_BACKEND_URL || "").replace(/\/+$/, "");
  const secret = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET;
  const userId = process.env.SMRTTASK_USER_ID;
  if (!backend || !secret) {
    throw new Error("SMRTESY_BACKEND_URL and SMRTBOT_INTERNAL_SECRET must be set to mint a session (or pass --no-auth).");
  }
  const q = userEmail ? `user_email=${encodeURIComponent(userEmail)}` : `user_id=${encodeURIComponent(userId || "")}`;
  if (!userEmail && !userId) throw new Error("Set SMRTTASK_USER_ID or pass --user-email (or --no-auth).");
  const url = `${backend}/api/claude-session/app-access?${q}`;
  const res = await fetch(url, { headers: { "x-cron-secret": secret } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `backend ${res.status} from /api/claude-session/app-access — ${body.slice(0, 300)}\n` +
        `(If this endpoint 404s, the backend hasn't deployed it yet — run --no-auth for a render-only check meanwhile.)`,
    );
  }
  return res.json();
}

// Config is passed to `next dev` via the child's ENVIRONMENT, not a written
// .env.local: Next inlines NEXT_PUBLIC_* from process.env, real env vars win over
// .env files, and this never clobbers a developer's own .env.local. If publicEnv
// is empty (e.g. --no-auth before the backend endpoint is deployed), the child
// inherits our env and Next still loads any existing .env.local on its own.
function childEnv(publicEnv, devBypass) {
  const extra = {};
  for (const [k, v] of Object.entries(publicEnv || {})) if (v) extra[k] = v;
  if (devBypass) extra.NEXT_PUBLIC_DEV_BYPASS_AUTH = "true";
  return { ...process.env, NODE_ENV: "development", PORT: String(port), ...extra };
}

// ── 2. boot next dev, wait until the target route answers ─────────────────────
async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}${targetPath}`, { redirect: "manual" });
      // Any HTTP answer (200 / 3xx redirect / even 500) means the dev server is
      // up and the route compiled; we assess correctness in the browser next.
      if (r.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

let devProc = null;
function startDev(env) {
  devProc = spawn(path.join(REPO_ROOT, "node_modules/.bin/next"), ["dev", "-p", String(port)], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so stopDev() can kill next's child compilers too
  });
  devProc.stdout.on("data", (b) => {
    const s = b.toString();
    if (/error|failed to compile/i.test(s)) process.stderr.write(`[next] ${s}`);
  });
  devProc.stderr.on("data", (b) => process.stderr.write(`[next] ${b}`));
  // Without a listener a spawn failure (e.g. `next` binary missing) emits an
  // 'error' event that crashes outside the promise chain; catch it as a clean fail.
  devProc.on("error", (e) => fail(`could not start next dev: ${e.message}`));
}
function stopDev() {
  if (devProc && !devProc.killed) {
    try {
      process.kill(-devProc.pid, "SIGKILL");
    } catch {
      try {
        devProc.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

// On Ctrl-C / harness timeout the process dies WITHOUT running main().finally,
// and because next dev is a detached group leader it would survive as an orphan
// holding the port (+ a leaked Chromium). Tear it down on the signals too.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopDev();
    process.exit(1);
  });
}

// ── 3. drive the browser ──────────────────────────────────────────────────────
async function drive(cookies) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-extensions",
      "--mute-audio",
      "--no-first-run",
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (cookies?.length) {
      await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: baseUrl })));
    }
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console.error: ${m.text().slice(0, 400)}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 400)}`));
    page.on("requestfailed", (r) => {
      const f = r.failure()?.errorText || "";
      // favicon / analytics noise is not a page defect
      if (!/favicon|_vercel|analytics/i.test(r.url())) problems.push(`requestfailed: ${r.url().slice(0, 200)} (${f})`);
    });
    page.on("response", (r) => {
      const s = r.status();
      const u = r.url();
      if (s >= 400 && !/favicon|_next\/static|analytics/i.test(u)) problems.push(`http ${s}: ${u.slice(0, 200)}`);
    });

    mkdirSync(outDir, { recursive: true });
    const shots = [];
    const shot = async (name = "shot") => {
      const file = path.join(outDir, `${String(name).replace(/[^\w.-]/g, "_")}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => {});
      shots.push(file);
      log(`  📸 ${file}`);
      return file;
    };
    const goto = async (p) => {
      const url = p.startsWith("http") ? p : `${baseUrl}${p.startsWith("/") ? p : `/${p}`}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 150_000 });
    };
    const expectVisible = async (selector, { timeout = 15_000, label } = {}) => {
      try {
        await page.locator(selector).first().waitFor({ state: "visible", timeout });
        log(`  ✓ visible: ${label || selector}`);
      } catch {
        throw new Error(`expected element not visible: ${label || selector}`);
      }
    };

    // Baseline smoke — every scenario stands on this: the screen loads and shows
    // real chrome, not a crash/login wall.
    log(`\n▶ opening ${baseUrl}${targetPath}`);
    await goto(targetPath);
    await page.waitForTimeout(2500); // let client hydrate + first data settle
    await shot("01-loaded");
    const landedOnLogin = /\/login(\?|$)/.test(page.url());
    if (landedOnLogin && !noAuth) throw new Error(`redirected to login (${page.url()}) — session cookie not accepted`);

    // Full interaction scenario, if provided.
    if (scenarioPath) {
      const abs = path.resolve(REPO_ROOT, scenarioPath);
      if (!existsSync(abs)) throw new Error(`scenario not found: ${abs}`);
      const mod = await import(pathToFileURL(abs).href);
      const run = mod.default;
      if (typeof run !== "function") throw new Error(`${scenarioPath} must export default async ({ page, goto, ... }) => {}`);
      log(`\n▶ scenario ${scenarioPath}`);
      await run({ page, context, baseUrl, targetPath, goto, shot, log, expectVisible });
    }

    return shots;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── orchestrate ───────────────────────────────────────────────────────────────
async function main() {
  let cookies = [];
  let publicEnv = {};
  if (noAuth) {
    log("⚠ --no-auth: using dev-bypass; backend API calls will 401, data screens may error.");
    // dev-bypass still needs the public Supabase config to construct the client;
    // pull it from the endpoint if we can, else the user must have .env.local.
    try {
      const a = await fetchAppAccess();
      publicEnv = a.public_env || {};
    } catch (e) {
      log(`  (couldn't fetch public config: ${e.message}); relying on an existing .env.local`);
    }
  } else {
    const access = await fetchAppAccess();
    cookies = access.cookies || [];
    publicEnv = access.public_env || {};
    if (access.missing?.length) {
      log(`⚠ backend is missing public config: ${access.missing.join(", ")}`);
      log("  The local app may fail to authenticate. Add these to the backend service (Railway) or a local .env.local.");
      log("  anon key: https://supabase.com/dashboard/project/exjnlghuzuvqedlltztz/settings/api");
    }
    if (!cookies.length) throw new Error("backend returned no session cookies");
  }

  log(`\n▶ starting next dev on :${port} (first compile can take ~20-40s)`);
  startDev(childEnv(publicEnv, noAuth));
  const ready = await waitForReady(120_000);
  if (!ready) throw new Error("next dev did not become ready within 120s");

  const shots = await drive(cookies);

  // ── verdict ─────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  if (problems.length) {
    console.log(`page-check found ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  • ${p}`);
    fail(`${problems.length} runtime problem(s) on ${targetPath}`);
  } else {
    console.log(`✓ page-check PASSED — ${targetPath} loaded and the scenario ran with no runtime errors.`);
  }
  if (shots.length) console.log(`screenshots: ${outDir}`);
  console.log("─".repeat(60));
}

main()
  .catch((e) => fail(e?.message || String(e)))
  .finally(() => {
    if (!keep) stopDev();
    // give SIGKILL a beat to land so the port frees for the next run
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
