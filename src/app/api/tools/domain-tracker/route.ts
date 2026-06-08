/**
 * Thin proxy — forwards the domain-tracker scan request to the Railway
 * backend (where Playwright + Chromium are available) and streams the
 * response back.  Auth is preserved: the client's Bearer token is forwarded
 * as-is, and the backend re-validates it before running the scan.
 *
 * This proxy exists so the page can call a consistent /api/* path regardless
 * of how NEXT_PUBLIC_BACKEND_URL is configured in a given environment.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const backendBase =
    process.env.BACKEND_URL ??
    process.env.NEXT_PUBLIC_BACKEND_URL ??
    "http://localhost:3001";

  const authHeader = request.headers.get("Authorization") ?? "";
  const body = await request.text();

  let response: Response;
  try {
    response = await fetch(`${backendBase}/api/admin/domain-tracker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
      signal: AbortSignal.timeout(55_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not reach backend: ${msg}` },
      { status: 502 },
    );
  }

  const data = await response.text();
  let json: unknown;
  try {
    json = data ? JSON.parse(data) : null;
  } catch {
    json = { error: data };
  }

  return NextResponse.json(json, { status: response.status });
}
