/**
 * smrtReach — email address validation (botsite emailValidator.js parity).
 *
 * Syntax check + DNS MX lookup per domain, with a short in-process cache so a
 * large blast resolves each domain once. Runs on the long-lived Railway server
 * where DNS is available (not in an edge/serverless context).
 */

import { resolveMx } from "node:dns/promises";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// domain → { ok, at } with a 30-minute TTL (botsite used the same window).
const mxCache = new Map<string, { ok: boolean; at: number }>();
const MX_TTL_MS = 30 * 60_000;

// Error codes that mean the domain definitively can't receive mail.
const UNDELIVERABLE_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/**
 * True if the domain has at least one MX record (cached). Only DEFINITIVE
 * negatives (NXDOMAIN / no records) are cached as undeliverable. TRANSIENT DNS
 * errors (timeout, SERVFAIL, resolver unreachable) are treated optimistically
 * (deliverable) and NOT cached — so a DNS blip never silently drops an entire
 * campaign's audience.
 */
async function domainHasMx(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_TTL_MS) return cached.ok;
  try {
    const records = await resolveMx(domain);
    const ok = Array.isArray(records) && records.length > 0;
    mxCache.set(domain, { ok, at: Date.now() });
    return ok;
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : "";
    if (UNDELIVERABLE_CODES.has(code)) {
      mxCache.set(domain, { ok: false, at: Date.now() });
      return false;
    }
    return true; // transient — don't penalize, don't cache
  }
}

/**
 * Filter a list of email addresses down to the ones that are syntactically
 * valid AND whose domain has MX records. Domains are de-duplicated so the DNS
 * cost is bounded by the number of distinct domains, not recipients.
 */
export async function filterDeliverableEmails(emails: string[]): Promise<Set<string>> {
  const keep = new Set<string>();
  const byDomain = new Map<string, string[]>();
  for (const email of emails) {
    if (!EMAIL_RE.test(email)) continue;
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    const arr = byDomain.get(domain) ?? [];
    arr.push(email);
    byDomain.set(domain, arr);
  }
  await Promise.all(
    [...byDomain.entries()].map(async ([domain, list]) => {
      if (await domainHasMx(domain)) for (const e of list) keep.add(e);
    }),
  );
  return keep;
}
