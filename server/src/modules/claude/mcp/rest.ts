/**
 * Minimal REST helper shared by the connector MCP servers. Node 20+ has global
 * `fetch`, so there is no dependency here. Every call returns the parsed body
 * (JSON when possible, else raw text) together with the status, and NEVER throws
 * on a non-2xx — the caller decides how to surface an API error to the model,
 * which is usually "show it the real response" rather than hide it.
 */

export interface RestResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON, otherwise null. */
  json: unknown;
  /** Raw text body (always present). */
  text: string;
}

export async function restRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  } = {},
): Promise<RestResult> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body ?? undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Format a REST result for return to the model. On success returns pretty JSON
 * (or raw text); on failure returns a clear, non-throwing error line that
 * includes the status and the API's own message, so the agent can adapt instead
 * of guessing.
 */
export function formatResult(label: string, r: RestResult, maxChars = 20000): string {
  const body = r.json !== null ? JSON.stringify(r.json, null, 2) : r.text;
  const clipped = body.length > maxChars ? body.slice(0, maxChars) + "\n…(truncated)" : body;
  if (!r.ok) return `${label} failed (HTTP ${r.status}):\n${clipped || "(empty body)"}`;
  return clipped || "(empty response)";
}

/** Read a required string arg or throw a clear error. */
export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`Missing required "${key}"`);
  return v;
}

/** Read an optional string arg. */
export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
