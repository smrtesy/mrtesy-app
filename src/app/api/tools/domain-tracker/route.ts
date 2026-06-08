export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

async function runScan(targetUrl: string): Promise<ScanResult> {
  // playwright-core lets us point at the pre-installed Chromium binary
  // without bundling or downloading browsers as part of this package.
  const { chromium } = await import("playwright-core");

  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

  // Fail fast with a clear message rather than a cryptic Playwright error
  const { existsSync } = await import("fs");
  if (!existsSync(executablePath)) {
    throw new Error(
      `Chromium not found at ${executablePath}. Set CHROMIUM_EXECUTABLE_PATH env var to the correct binary path.`,
    );
  }

  const browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    type RawRequest = { domain: string; type: string };
    const raw: RawRequest[] = [];

    page.on("request", (req) => {
      try {
        const u = new URL(req.url());
        if (u.hostname) {
          raw.push({ domain: u.hostname, type: req.resourceType() });
        }
      } catch {
        // malformed url — skip
      }
    });

    // waitUntil:"networkidle" waits until no more than 0 network connections
    // for at least 500 ms — catches deferred XHR/fetch calls.
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Extra wait to catch anything that fires after networkidle (lazy analytics,
    // beacon pings, etc.)
    await page.waitForTimeout(2_000);

    await browser.close();

    const parsed = new URL(targetUrl);
    const mainDomain = parsed.hostname;

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
        isMain:
          domain === mainDomain ||
          domain.endsWith(`.${mainDomain}`),
      }))
      .sort((a, b) => {
        if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
        return b.count - a.count;
      });

    return {
      domains,
      mainDomain,
      totalRequests: raw.length,
      totalDomains: domains.length,
      scannedUrl: targetUrl,
    };
  } catch (err) {
    console.error("[domain-tracker] scan failed for", targetUrl, err);
    await browser.close();
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminEmails = (process.env.ADMIN_EMAIL || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const { data: adminRow } = await supabase
    .from("super_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const isAdmin =
    !!adminRow || adminEmails.includes(user.email?.toLowerCase() ?? "");

  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("bad protocol");
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid URL — must start with http:// or https://" },
      { status: 400 },
    );
  }

  try {
    const result = await runScan(parsedUrl.toString());
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Scan failed: ${message}` },
      { status: 500 },
    );
  }
}
