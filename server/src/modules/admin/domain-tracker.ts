/**
 * Admin: domain-access tracker.
 * Launches a headless Chromium browser, navigates to the target URL,
 * intercepts every network request, and returns a deduplicated list of
 * hostnames — grouped by count and resource type.
 *
 * Requires requireAuth + requireSuperAdmin (applied in the admin index router).
 *
 * POST /api/admin/domain-tracker
 * Body: { url: string }
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireSuperAdmin } from "../../middleware";

const router = Router();

type DomainEntry = {
  domain: string;
  count: number;
  types: string[];
  isMain: boolean;
};

type ScanResult = {
  domains: DomainEntry[];
  mainDomain: string;
  totalRequests: number;
  totalDomains: number;
  scannedUrl: string;
};

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

    // playwright uses its own downloaded Chromium — no executablePath needed.
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

    const raw: Array<{ domain: string; type: string }> = [];

    page.on("request", (r) => {
      try {
        const u = new URL(r.url());
        if (u.hostname) raw.push({ domain: u.hostname, type: r.resourceType() });
      } catch {
        // malformed url — skip
      }
    });

    await page.goto(parsedUrl.toString(), {
      waitUntil: "load",
      timeout: 30_000,
    });

    // Extra wait for lazy analytics / beacon pings
    await page.waitForTimeout(2_000);

    await browser.close();
    browser = null;

    const mainDomain = parsedUrl.hostname;
    const domainMap = new Map<string, { count: number; types: Set<string> }>();

    for (const r of raw) {
      const e = domainMap.get(r.domain);
      if (e) {
        e.count++;
        e.types.add(r.type);
      } else {
        domainMap.set(r.domain, { count: 1, types: new Set([r.type]) });
      }
    }

    const domains: DomainEntry[] = Array.from(domainMap.entries())
      .map(([domain, info]) => ({
        domain,
        count: info.count,
        types: Array.from(info.types).sort(),
        isMain: domain === mainDomain || domain.endsWith(`.${mainDomain}`),
      }))
      .sort((a, b) => {
        if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
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
    return res.status(500).json({ error: `Scan failed: ${message}` });
  }
});

export default router;
