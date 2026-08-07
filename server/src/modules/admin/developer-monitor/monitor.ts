/**
 * Developer-access monitor — stage 1b of the security-hardening plan.
 * Design: docs/developer-access-monitor-plan.md.
 *
 * Pulls postgres_logs for the `developer` DB role (Ayman) via the Supabase
 * Management API, geo-locates new client IPs (ipinfo), and writes anomalies to
 * log_entries with level='error' — the existing trg_notify_superadmins_on_error
 * trigger then alerts super-admins and the daily health-check reports them. We
 * DETECT, we do not prevent (pgaudit already logs to an append-only journal the
 * developer cannot erase — migration 20260806120000).
 *
 * Anomalies (docs/developer-access-monitor-plan.md §ספים):
 *   🔴 new country / new ASN for a developer connection      → error
 *   🔴 touch of user_credentials / app_secrets / org_secrets → error
 *   🔴 decrypt_token / vault attempt (even if blocked)       → error
 *   🟠 mass-pull approximation from source_messages          → error (distinct category)
 *
 * State tables (migration 20260807170000): developer_access_baseline (known
 * ip→country/asn) + developer_access_checkpoint (log high-water mark). Both are
 * REVOKEd from the developer role so it cannot tamper with its own monitor.
 */

import { db, getAppSecret } from "../../../db";

// In-process guards. The backend is a single Railway service, so a module-level
// flag is enough to stop pg_cron from overlapping two sweeps (both would read
// the same checkpoint and double-write). Cooldown caps fetch-failure alerts so a
// sustained Management-API outage doesn't fire a notification every 5 minutes.
let sweepRunning = false;
let lastFailAlertMs = 0;
const FAIL_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const DB_USER = "developer";
const TOKEN_APP_SLUG = "smrttask"; // where SUPABASE_ACCESS_TOKEN lives (app_secrets, env fallback)

// Ingestion safety lag: never process a log row younger than this, giving
// Logflare time to ingest. Combined with a strictly-increasing checkpoint this
// makes each row processed exactly once (no dupes, no misses).
const LAG_MS = 2 * 60 * 1000;
// Cap the scan window so a stalled checkpoint (developer never connects for
// days) doesn't ask Logflare for an unbounded range. Logs retention is short
// anyway; anything older is gone.
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 1000;
const LOGS_TIMEOUT_MS = 20_000;
const GEO_TIMEOUT_MS = 5_000;
// Mass-pull heuristic (plan §ד): more than this many source_messages SELECTs in
// one batch, OR any source_messages SELECT with no WHERE (a full-table scan).
const MASS_PULL_THRESHOLD = 20;

// Sensitive tables whose mere touch by `developer` is worth an alert.
const SENSITIVE_TABLES = /\b(user_credentials|app_secrets|org_secrets)\b/i;
// Any attempt to decrypt tokens or reach the vault schema (blocked or not).
const DECRYPT_ATTEMPT = /\bdecrypt_token\b|\bvault\b|vault_read_secret|decrypted_secret/i;

interface LogRow {
  ts: number; // microseconds since epoch (BigQuery INT64)
  connection_from: string | null;
  error_severity: string | null;
  event_message: string;
}

interface GeoInfo {
  country: string | null; // ISO-2, e.g. "IN"
  asn: string | null; // ipinfo `org`, e.g. "AS14618 Amazon.com, Inc."
}

export interface MonitorResult {
  processed: number;
  windowStart: string | null;
  windowEnd: string | null;
  findings: string[]; // category slugs written this run
  newIps: number;
}

/** The Supabase project ref, from SUPABASE_URL (`https://<ref>.supabase.co`). */
function supabaseRef(): string | null {
  const url = process.env.SUPABASE_URL || "";
  return /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url)?.[1] ?? null;
}

/** GET JSON with a timeout. Returns null on any network/timeout error. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip the trailing `:port` Supabase appends to connection_from, leaving a bare
 * IP for geo lookup. Handles IPv4 (`1.2.3.4:5678`) and IPv6
 * (`2600:1f16:…:7b31:41988` → `2600:1f16:…:7b31`, `::1:64225` → `::1`). The log
 * always carries a port, so we always strip the last `:<digits>` group.
 */
function bareIp(connectionFrom: string): string {
  const s = connectionFrom.trim();
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/.exec(s);
  if (v4) return v4[1];
  const m = /^(.*):\d+$/.exec(s);
  return m ? m[1] : s;
}

/** Resolve an IP → country + ASN via ipinfo. Free tier; token optional. */
async function geoLookup(ip: string): Promise<GeoInfo> {
  const token = (await getAppSecret(TOKEN_APP_SLUG, "IPINFO_TOKEN", "IPINFO_TOKEN"))?.trim();
  const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${token}` : ""}`;
  const body = (await getJson(url, { Accept: "application/json" }, GEO_TIMEOUT_MS)) as
    | { country?: string; org?: string }
    | null;
  if (!body) return { country: null, asn: null };
  return {
    country: typeof body.country === "string" ? body.country : null,
    asn: typeof body.org === "string" ? body.org : null,
  };
}

/**
 * Parse a pgaudit SESSION line. Format (comma-separated after "AUDIT: SESSION,"):
 *   statement_id, substatement_id, class, command, object_type, object_name,
 *   statement, parameter
 * The leading four fields never contain commas; the statement (field 7) can, so
 * we don't split it out precisely — callers scan the whole event_message for
 * table/keyword patterns, which is robust to CSV quoting.
 */
function parseAudit(msg: string): { class: string; command: string } | null {
  // Not anchored to ^ — the AUDIT record may carry a prefix in some log formats.
  const m = /AUDIT:\s*SESSION,\d+,\d+,([A-Z]+),([A-Z ]+),/.exec(msg);
  if (!m) return null;
  return { class: m[1], command: m[2].trim() };
}

/**
 * Fetch developer log rows in (checkpointMicros, cutoffMicros] via the Management
 * API. Returns null on a FETCH/QUERY FAILURE (network, timeout, non-2xx, or a
 * BigQuery error) — distinct from an empty array (success, no rows). The caller
 * must NOT advance the checkpoint on null, or a Management-API outage would
 * silently skip the developer activity in that window.
 */
async function fetchDeveloperLogs(
  ref: string,
  token: string,
  startIso: string,
  endIso: string,
  checkpointMicros: number,
  cutoffMicros: number,
): Promise<LogRow[] | null> {
  const sql = [
    "select t.timestamp as ts,",
    "  parsed.connection_from as connection_from,",
    "  parsed.error_severity as error_severity,",
    "  event_message as event_message",
    "from postgres_logs as t",
    "cross join unnest(t.metadata) as m",
    "cross join unnest(m.parsed) as parsed",
    `where parsed.user_name = '${DB_USER}'`,
    `  and t.timestamp > ${checkpointMicros}`,
    `  and t.timestamp <= ${cutoffMicros}`,
    "order by t.timestamp asc",
    `limit ${MAX_ROWS}`,
  ].join(" ");

  const url =
    `https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all` +
    `?sql=${encodeURIComponent(sql)}` +
    `&iso_timestamp_start=${encodeURIComponent(startIso)}` +
    `&iso_timestamp_end=${encodeURIComponent(endIso)}`;

  const body = (await getJson(url, { Authorization: `Bearer ${token}` }, LOGS_TIMEOUT_MS)) as
    | { result?: LogRow[]; error?: unknown }
    | null;
  // null body = network/timeout/non-2xx; body.error = BigQuery error. Both are
  // failures — signal null so the caller holds the checkpoint. Only a well-formed
  // result array (possibly empty) is a success.
  if (!body || body.error || !Array.isArray(body.result)) return null;
  return body.result.filter((r) => typeof r.ts === "number" && typeof r.event_message === "string");
}

/** Write one anomaly row. level='error' fires the existing super-admin alert path. */
async function writeAnomaly(
  category: string,
  message: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("log_entries").insert({
    level: "error",
    category,
    status: "failed",
    source_type: "security",
    subject: "מנטר-גישת-המתכנת",
    error_message: message,
    details,
  });
  if (error) console.error(`[dev-monitor] failed to write ${category}:`, error.message);
}

export async function runDeveloperAccessMonitor(): Promise<MonitorResult> {
  if (sweepRunning) {
    // A previous sweep is still going (slow geo lookups). Skip this tick rather
    // than double-read the same window.
    return { processed: 0, windowStart: null, windowEnd: null, findings: ["busy"], newIps: 0 };
  }
  sweepRunning = true;
  try {
    return await runSweep();
  } finally {
    sweepRunning = false;
  }
}

async function runSweep(): Promise<MonitorResult> {
  const ref = supabaseRef();
  const token = (await getAppSecret(TOKEN_APP_SLUG, "SUPABASE_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN"))?.trim();
  if (!ref || !token) {
    console.error("[dev-monitor] missing SUPABASE_ACCESS_TOKEN or project ref — skipping.");
    return { processed: 0, windowStart: null, windowEnd: null, findings: [], newIps: 0 };
  }

  // ── checkpoint (high-water mark) ──
  const { data: cp } = await db
    .from("developer_access_checkpoint")
    .select("last_processed_at")
    .eq("db_user", DB_USER)
    .maybeSingle();
  const checkpointMs = cp?.last_processed_at ? new Date(cp.last_processed_at).getTime() : Date.now() - LAG_MS;

  const nowMs = Date.now();
  const cutoffMs = nowMs - LAG_MS; // don't touch rows younger than the ingestion lag
  if (cutoffMs <= checkpointMs) {
    // Nothing has aged past the lag since the last run. No-op, checkpoint unchanged.
    return { processed: 0, windowStart: null, windowEnd: null, findings: [], newIps: 0 };
  }
  const startMs = Math.max(checkpointMs, nowMs - MAX_LOOKBACK_MS);
  const startIso = new Date(startMs).toISOString();
  const cutoffIso = new Date(cutoffMs).toISOString();

  const rows = await fetchDeveloperLogs(
    ref,
    token,
    startIso,
    cutoffIso,
    checkpointMs * 1000,
    cutoffMs * 1000,
  );

  if (rows === null) {
    // Fetch/query failure — hold the checkpoint so the next successful sweep
    // covers this window (up to MAX_LOOKBACK). Alert at most once per cooldown so
    // a sustained outage doesn't spam. The monitor being blind IS an incident.
    console.error("[dev-monitor] log fetch failed — checkpoint held.");
    const nowMs2 = Date.now();
    if (nowMs2 - lastFailAlertMs > FAIL_ALERT_COOLDOWN_MS) {
      lastFailAlertMs = nowMs2;
      await writeAnomaly(
        "dev_monitor_error",
        `⚠️ סוויף מנטר-גישת-המתכנת נכשל במשיכת הלוגים מה-Management API. ה-checkpoint מוחזק — הרצה מוצלחת הבאה תכסה את החלון. אם זה חוזר, ה-DB-role "developer" עלול לפעול בלי ניטור.`,
        { db_user: DB_USER, window_start: startIso, window_end: cutoffIso, severity: "red" },
      );
    }
    return { processed: 0, windowStart: startIso, windowEnd: cutoffIso, findings: ["dev_monitor_error"], newIps: 0 };
  }

  // ── baseline: known (country, asn, ip) for this developer ──
  const { data: baseRows } = await db
    .from("developer_access_baseline")
    .select("ip, country, asn")
    .eq("db_user", DB_USER);
  const knownIps = new Set<string>((baseRows ?? []).map((r) => String(r.ip)));
  const knownCountries = new Set<string>((baseRows ?? []).map((r) => r.country).filter(Boolean) as string[]);
  const knownAsns = new Set<string>((baseRows ?? []).map((r) => r.asn).filter(Boolean) as string[]);
  const baselineSeeded = (baseRows ?? []).length > 0;

  const findings = new Set<string>();

  // ── 1. geo of new connection IPs ──
  const seenIps = new Map<string, GeoInfo>(); // bareIp → geo (resolved once)
  for (const r of rows) {
    if (!r.connection_from) continue;
    const ip = bareIp(r.connection_from);
    if (seenIps.has(ip) || knownIps.has(ip)) continue;
    const geo = await geoLookup(ip);
    seenIps.set(ip, geo);

    // New country / ASN only mean something once a baseline exists; the very
    // first observation bootstraps it silently (learning). A resolved value not
    // in the known set is a red flag; an UNRESOLVED value never alerts (a geo
    // outage must not manufacture an anomaly — fail closed toward silence here).
    if (baselineSeeded) {
      if (geo.country && !knownCountries.has(geo.country)) {
        findings.add("dev_access_geo");
        await writeAnomaly(
          "dev_access_geo",
          `🔴 חיבור של תפקיד ה-DB "developer" ממדינה חדשה: ${geo.country} (IP ${ip}, ${geo.asn ?? "ASN לא ידוע"}). לא נראה קודם בבסיס.`,
          { db_user: DB_USER, ip, country: geo.country, asn: geo.asn, kind: "new_country", severity: "red" },
        );
      } else if (geo.asn && !knownAsns.has(geo.asn)) {
        findings.add("dev_access_geo");
        await writeAnomaly(
          "dev_access_geo",
          `🔴 חיבור של תפקיד ה-DB "developer" מרשת/ספק חדש (ASN): ${geo.asn} (IP ${ip}, מדינה ${geo.country ?? "לא ידועה"}).`,
          { db_user: DB_USER, ip, country: geo.country, asn: geo.asn, kind: "new_asn", severity: "red" },
        );
      }
    }
    // Once resolved, treat as known within this run so later rows don't re-alert.
    if (geo.country) knownCountries.add(geo.country);
    if (geo.asn) knownAsns.add(geo.asn);
  }

  // ── 2. per-row content anomalies (decrypt/vault, sensitive tables) ──
  const decryptHits: string[] = [];
  const sensitiveHits: string[] = [];
  const massPull: string[] = [];
  let massPullNoWhere = false;

  for (const r of rows) {
    const msg = r.event_message;

    if (DECRYPT_ATTEMPT.test(msg)) {
      decryptHits.push(msg.slice(0, 300));
    }

    const audit = parseAudit(msg);
    if (audit) {
      if (SENSITIVE_TABLES.test(msg)) sensitiveHits.push(msg.slice(0, 300));
      if (audit.command === "SELECT" && /\bsource_messages\b/i.test(msg)) {
        massPull.push(msg.slice(0, 300));
        // A SELECT on source_messages with no WHERE is a full-table read.
        if (!/\bwhere\b/i.test(msg)) massPullNoWhere = true;
      }
    } else if (SENSITIVE_TABLES.test(msg)) {
      // A non-AUDIT line (e.g. an ERROR) that names a sensitive table still counts.
      sensitiveHits.push(msg.slice(0, 300));
    }
  }

  if (decryptHits.length) {
    findings.add("dev_access_decrypt");
    await writeAnomaly(
      "dev_access_decrypt",
      `🔴 תפקיד ה-DB "developer" ניסה פענוח/גישה ל-vault (${decryptHits.length} שורות, נחסם או לא). זהו ניסיון-פענוח מפורש.`,
      { db_user: DB_USER, count: decryptHits.length, samples: decryptHits.slice(0, 5), severity: "red" },
    );
  }
  if (sensitiveHits.length) {
    findings.add("dev_access_sensitive");
    await writeAnomaly(
      "dev_access_sensitive",
      `🔴 תפקיד ה-DB "developer" נגע בטבלה רגישה (user_credentials/app_secrets/org_secrets) — ${sensitiveHits.length} שורות.`,
      { db_user: DB_USER, count: sensitiveHits.length, samples: sensitiveHits.slice(0, 5), severity: "red" },
    );
  }
  if (massPull.length > MASS_PULL_THRESHOLD || massPullNoWhere) {
    findings.add("dev_access_masspull");
    await writeAnomaly(
      "dev_access_masspull",
      `🟠 חשד למשיכת-מסה מ-source_messages ע"י "developer": ${massPull.length} שאילתות SELECT${massPullNoWhere ? ", כולל SELECT ללא WHERE (סריקת-טבלה מלאה)" : ""} בחלון.`,
      {
        db_user: DB_USER,
        count: massPull.length,
        no_where: massPullNoWhere,
        threshold: MASS_PULL_THRESHOLD,
        samples: massPull.slice(0, 5),
        severity: "orange",
      },
    );
  }

  // ── 3. persist baseline ──
  const nowIso = new Date().toISOString();
  const ipsThisRun = new Set<string>();
  for (const r of rows) {
    if (r.connection_from) ipsThisRun.add(bareIp(r.connection_from));
  }
  // New IPs whose geo resolved → record them. An UNRESOLVED new IP is skipped
  // (not baselined) so the next run retries geo — otherwise a one-off ipinfo
  // outage would whitelist a real IP forever with a null country.
  for (const [ip, geo] of seenIps) {
    if (!geo.country && !geo.asn) continue;
    const { error } = await db.from("developer_access_baseline").upsert(
      { db_user: DB_USER, ip, country: geo.country, asn: geo.asn, last_seen_at: nowIso },
      { onConflict: "db_user,ip", ignoreDuplicates: false },
    );
    if (error) console.error("[dev-monitor] baseline insert failed:", error.message);
  }
  // Already-known IPs seen again → bump last_seen_at only. Never re-write their
  // country/asn (we didn't re-resolve them, so a full upsert would clobber the
  // stored values with null).
  const knownSeen = [...ipsThisRun].filter((ip) => knownIps.has(ip));
  if (knownSeen.length) {
    const { error } = await db
      .from("developer_access_baseline")
      .update({ last_seen_at: nowIso })
      .eq("db_user", DB_USER)
      .in("ip", knownSeen);
    if (error) console.error("[dev-monitor] baseline touch failed:", error.message);
  }

  // ── 4. advance the checkpoint (monotonic; never backward) ──
  // If the result hit the row cap, the window may hold more rows past the last
  // one we got — advance only to that last row's timestamp, so the next run
  // continues from there instead of skipping the tail. Otherwise advance to the
  // cutoff (the whole aged window is covered).
  let newCheckpointMs = cutoffMs;
  if (rows.length >= MAX_ROWS && rows.length > 0) {
    newCheckpointMs = Math.floor(rows[rows.length - 1].ts / 1000);
  }
  const newCheckpointIso = new Date(Math.max(checkpointMs, newCheckpointMs)).toISOString();
  const { error: cpErr } = await db
    .from("developer_access_checkpoint")
    .upsert(
      { db_user: DB_USER, last_processed_at: newCheckpointIso, updated_at: nowIso },
      { onConflict: "db_user" },
    );
  if (cpErr) console.error("[dev-monitor] checkpoint update failed:", cpErr.message);

  return {
    processed: rows.length,
    windowStart: startIso,
    windowEnd: cutoffIso,
    findings: [...findings],
    newIps: seenIps.size,
  };
}
