/**
 * Admin: domain-access tracker.
 * Launches a headless Chromium browser, navigates to the target URL,
 * intercepts every network request, and returns a deduplicated list of
 * hostnames — grouped by count and resource type.
 *
 * Each domain is classified by load phase so callers can tell which
 * domains must be whitelisted in filtered networks:
 *   "blocking"    — requested before DOMContentLoaded with a render-blocking
 *                   type (script/stylesheet/document).  If blocked, the page
 *                   will hang or fail to render.
 *   "functional"  — requested before the load event but not render-blocking.
 *                   Blocking it may break interactive features (XHR, fetch).
 *   "optional"    — requested after the load event (analytics, lazy media,
 *                   beacon pings).  Safe to block.
 *
 * POST /api/admin/domain-tracker
 * Body: { url: string }
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireSuperAdmin } from "../../middleware";

const router = Router();

type LoadPhase = "blocking" | "functional" | "optional";

type DomainEntry = {
  domain: string;
  count: number;
  types: string[];
  isMain: boolean;
  loadPhase: LoadPhase;
};

type ScanResult = {
  domains: DomainEntry[];
  mainDomain: string;
  totalRequests: number;
  totalDomains: number;
  scannedUrl: string;
};

const BLOCKING_TYPES = new Set(["document", "script", "stylesheet"]);

function worstPhase(a: LoadPhase, b: LoadPhase): LoadPhase {
  const rank: Record<LoadPhase, number> = { blocking: 0, functional: 1, optional: 2 };
  return rank[a] <= rank[b] ? a : b;
}

router.post("/admin/domain-tracker", requireAuth, requireSuperAdmin, async (req: Request, res: Response) => {
  const rawUrl = (typeof req.body?.url === "string" ? req.body.url : "").trim();
  if (!rawUrl) {
    return res.status(400).json({ error: "url is required" });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("bad protocol");
  } catch {
    return res.status(400).json({ error: "Invalid URL — must start with http:// or https://" });
  }

  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");

    browser = await chromium.launch({
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

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Track load phase transitions.
    let currentPhase: LoadPhase = "blocking";
    page.on("domcontentloaded", () => { currentPhase = "functional"; });

    const raw: Array<{ domain: string; type: string; phase: LoadPhase }> = [];

    page.on("request", (r) => {
      try {
        const u = new URL(r.url());
        if (!u.hostname) return;
        const type = r.resourceType();
        // A request is render-blocking only if it fires before DCL AND has a
        // blocking type.  After DCL the phase switches to "functional".
        const phase: LoadPhase =
          currentPhase === "blocking" && BLOCKING_TYPES.has(type)
            ? "blocking"
            : currentPhase === "optional"
            ? "optional"
            : "functional";
        raw.push({ domain: u.hostname, type, phase });
      } catch {
        // malformed url — skip
      }
    });

    await page.goto(parsedUrl.toString(), {
      waitUntil: "load",
      timeout: 30_000,
    });

    // Switch to optional phase: anything fired after load is non-critical.
    currentPhase = "optional";

    // Extra wait for lazy analytics / beacon pings
    await page.waitForTimeout(2_000);

    await browser.close();
    browser = null;

    const mainDomain = parsedUrl.hostname;
    const domainMap = new Map<string, { count: number; types: Set<string>; loadPhase: LoadPhase }>();

    for (const r of raw) {
      const e = domainMap.get(r.domain);
      if (e) {
        e.count++;
        e.types.add(r.type);
        e.loadPhase = worstPhase(e.loadPhase, r.phase);
      } else {
        domainMap.set(r.domain, { count: 1, types: new Set([r.type]), loadPhase: r.phase });
      }
    }

    const domains: DomainEntry[] = Array.from(domainMap.entries())
      .map(([domain, info]) => ({
        domain,
        count: info.count,
        types: Array.from(info.types).sort(),
        isMain: domain === mainDomain || domain.endsWith(`.${mainDomain}`),
        loadPhase: info.loadPhase,
      }))
      .sort((a, b) => {
        // Sort: main first, then by severity (blocking > functional > optional), then by count
        if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
        const rank: Record<LoadPhase, number> = { blocking: 0, functional: 1, optional: 2 };
        if (rank[a.loadPhase] !== rank[b.loadPhase]) return rank[a.loadPhase] - rank[b.loadPhase];
        return b.count - a.count;
      });

    const result: ScanResult = {
      domains,
      mainDomain,
      totalRequests: raw.length,
      totalDomains: domains.length,
      scannedUrl: parsedUrl.toString(),
    };

    return res.json(result);
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[domain-tracker] scan failed for", rawUrl, err);
    // The Chromium download is opt-in to keep deploys fast (INSTALL_CHROMIUM=1).
    // Give a clear hint when the browser binary just isn't installed here.
    if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
      return res.status(503).json({ error: "Domain tracker is unavailable: the Chromium browser isn't installed on this server (set INSTALL_CHROMIUM=1 and redeploy)." });
    }
    return res.status(500).json({ error: `Scan failed: ${message}` });
  }
});

export default router;
