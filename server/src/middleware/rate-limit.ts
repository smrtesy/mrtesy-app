/**
 * Lightweight in-memory rate limiter for expensive endpoints (LLM calls,
 * full Gmail/Drive/Calendar sync). The API server is a long-running single
 * process (Railway), so a per-instance in-memory window is enough to stop a
 * single authenticated user from spamming a costly endpoint and burning
 * Google quota / LLM tokens. It is NOT a security boundary — auth still gates
 * access; this only caps request rate per caller.
 *
 * Keyed by user id when available (req.user is set by requireAuth), else by a
 * suffix of the bearer token, else by IP — so it works whether it runs before
 * or after the auth middleware.
 */
import type { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key within the window. */
  max: number;
  /** Optional custom key extractor. */
  key?: (req: Request) => string;
  /** Optional message returned in the 429 body. */
  message?: string;
}

// key → ascending list of hit timestamps (ms). Pruned on access; stale keys
// are swept periodically below.
const buckets = new Map<string, number[]>();

function defaultKey(req: Request): string {
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  if (userId) return `u:${userId}`;
  const auth = req.headers.authorization;
  if (auth) return `t:${auth.slice(-24)}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export function rateLimit(opts: RateLimitOptions) {
  const keyFn = opts.key ?? defaultKey;
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const id = `${req.method}:${req.baseUrl}${req.path}:${keyFn(req)}`;
    const recent = (buckets.get(id) ?? []).filter((t) => now - t < opts.windowMs);

    if (recent.length >= opts.max) {
      const retryMs = opts.windowMs - (now - recent[0]);
      res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
      res.status(429).json({
        error: opts.message ?? "Too many requests — please wait a moment and try again.",
      });
      return;
    }

    recent.push(now);
    buckets.set(id, recent);
    next();
  };
}

// Periodic sweep so keys for users who stopped calling don't accumulate.
// 10-minute interval, unref'd so it never keeps the process alive on its own.
const SWEEP_MS = 10 * 60 * 1000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of buckets) {
    // Drop a bucket once its newest hit is older than an hour — well past any
    // window we configure, so this never evicts a live limiter.
    if (hits.length === 0 || now - hits[hits.length - 1] > 60 * 60 * 1000) {
      buckets.delete(id);
    }
  }
}, SWEEP_MS);
sweep.unref?.();
