/**
 * The runner — executes one claude_runs row and records its full event stream.
 *
 * This is what makes Claude part of our software: the app launches the engine,
 * and every event it emits is written into OUR database as the source of truth.
 * Nothing here depends on claude.ai and nothing is a copy of state held there.
 *
 * WHY THE CLI AND NOT THE AGENT SDK (docs/claude-console/plan.md §4):
 * the Agent SDK wraps this same engine and emits this same event stream. Slice 1
 * drives the process directly with `--output-format stream-json` because it adds
 * ZERO new dependencies and the CLI has to be installed on the host either way.
 * Swapping in the SDK later is a drop-in: the event shapes are identical, so
 * neither the schema nor the screen changes.
 *
 * BILLING — reads as subscription, never as paid API tokens. Claude Code's
 * credential precedence puts ANTHROPIC_API_KEY *above* subscription auth, so a
 * key present in the backend's environment would silently bill this run to the
 * API. We strip it (and ANTHROPIC_AUTH_TOKEN) from the child environment and
 * require CLAUDE_CODE_OAUTH_TOKEN instead, failing loudly when it is absent
 * rather than falling back to a billed path.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db, getAppSecret } from "../../db";
import { notify } from "../../lib/platform/notify";
import { ensureClone, getGitHubToken, gitEnvForRun, redact } from "./github";
import { materializeAttachments } from "./attachments";
import { threadWorkspace } from "./workspace";
import { buildThreadTranscript } from "./transcript";
import { composePrompt } from "./playbooks";
import { mintAppAccess, revokeAppAccess, BROWSER_HELPER_PATH } from "./app-access";

/**
 * Where the subscription token is stored.
 *
 * app_secrets (via getAppSecret) rather than a bare Railway variable, for three
 * reasons: it is encrypted at rest in Supabase Vault, it is editable from our own
 * admin screen at /admin/apps/smrttask/secrets instead of a third-party
 * dashboard, and getAppSecret still falls back to the environment variable of the
 * same name — so an existing Railway variable keeps working unchanged.
 *
 * The slug is the platform's core app (smrttask, renamed from the legacy
 * "smrtesy") because this credential is platform infrastructure shared by every
 * Claude run, not a feature of one product.
 */
const TOKEN_APP_SLUG = "smrttask";
const TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Supabase migration credentials — what lets a run APPLY a migration it wrote, not
 * just write the file (the additive path a repo run applies itself, and the
 * destructive-apply run enqueued after human approval).
 *
 * The apply mechanism is the Supabase Management API `POST /v1/projects/{ref}/
 * database/query` — the SAME endpoint the platform already uses to run migrations
 * (the Supabase MCP), reached with a personal access token. It is deliberately NOT
 * `supabase db push`: this repo's local `supabase/migrations/` filenames are disjoint
 * from the remote `schema_migrations` history (the history was stamped by the MCP with
 * its own versions — only ~9 of 260 local files overlap), so `db push` would either
 * fail on out-of-order versions or, if forced, re-run ~250 historical migrations —
 * dozens of them destructive — against production. The Management API applies ONLY the
 * one file's SQL a run passes it, sidestepping that entirely, and needs only the access
 * token (no db password). The ref matches `project_id` in `supabase/config.toml`; it is
 * not a secret, so it is a default here (overridable by a SUPABASE_PROJECT_ID
 * app_secret) rather than required.
 *
 * Trade-off of the query endpoint: unlike the MCP's apply_migration, it does NOT stamp
 * `supabase_migrations.schema_migrations`, so a console-applied migration won't show in
 * `list_migrations`. Intentional here — the repo's history is disjoint from that table
 * already (above), so the migration file in git is the record; writing a version row
 * would invent yet another scheme. Nothing in the codebase reads schema_migrations. */
const SUPABASE_TOKEN_KEY = "SUPABASE_ACCESS_TOKEN";
const SUPABASE_PROJECT_ID_KEY = "SUPABASE_PROJECT_ID";
const SUPABASE_PROJECT_REF_DEFAULT = "exjnlghuzuvqedlltztz";

/**
 * A SECOND, independent Claude subscription account, dedicated to automated
 * background work.
 *
 * The primary token above authenticates the interactive runs the user drives from
 * the console. The automated workloads — the corrections triage/autofix and the
 * thread split/group suggestions — burn through a subscription's rolling usage
 * window on their own, and while they share the primary account they eat into the
 * budget the interactive work needs. Routing them to their own account keeps the
 * two usage windows separate.
 *
 * A run opts in by carrying `claude_account === AUTOMATION_ACCOUNT`. When this
 * token is not configured `loadAccountToken` falls back to the primary token, so
 * the routing is a harmless no-op until the operator adds the second account under
 * /admin/apps/smrttask/secrets (key CLAUDE_CODE_OAUTH_TOKEN_AUTOMATION).
 */
export const AUTOMATION_ACCOUNT = "automation";

/** The default account id — interactive console threads with no explicit choice
 *  run here (a NULL `claude_account` resolves to this token in loadAccountToken). */
export const PRIMARY_ACCOUNT = "primary";

/** The primary account's optional human label, so the operator can name it in the
 *  switcher ("החשבון של מאור") without a code change. Each extra account has its own
 *  CLAUDE_ACCOUNT_LABEL_<ID> (labelKeyFor). Unset → the UI falls back to a default
 *  label per account id. */
const PRIMARY_LABEL_KEY = "CLAUDE_ACCOUNT_LABEL";

/**
 * The console is no longer capped at two accounts. Beyond the built-in `primary`,
 * the set of extra accounts is a comma-separated registry secret so a THIRD (or
 * Nth) account is added with zero code change — just secrets under
 * /admin/apps/smrttask/secrets:
 *
 *   CLAUDE_ACCOUNTS            = automation,ai3      (the extra account ids)
 *   CLAUDE_CODE_OAUTH_TOKEN_AI3 = sk-ant-oat01-…     (that account's token)
 *   CLAUDE_ACCOUNT_LABEL_AI3    = ai3                (optional human label)
 *
 * Unset → the historical default `["automation"]`, so nothing changes for an
 * environment that never sets the registry. Each id maps to a token/label key by
 * the same convention the two original accounts already used: `primary` owns the
 * bare `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_ACCOUNT_LABEL`; every other id `X` owns
 * `CLAUDE_CODE_OAUTH_TOKEN_<UPPER(X)>` / `CLAUDE_ACCOUNT_LABEL_<UPPER(X)>` — which
 * for `X = automation` is exactly the pre-existing pair, so this is a pure
 * generalization with no migration.
 */
export const ACCOUNTS_REGISTRY_KEY = "CLAUDE_ACCOUNTS";
const DEFAULT_EXTRA_ACCOUNTS = [AUTOMATION_ACCOUNT];
/** A safe account id: lowercase letters/digits/underscore, so it can be pasted
 *  verbatim into an env-var name (`CLAUDE_CODE_OAUTH_TOKEN_<UPPER>`). */
export const ACCOUNT_ID_RE = /^[a-z0-9_]{1,32}$/;
/** The app slug all Claude account secrets live under (platform infrastructure).
 *  Exported so the accounts-admin router writes to the same place the runner reads. */
export const ACCOUNTS_APP_SLUG = TOKEN_APP_SLUG;

/** The secret key holding a given account's OAuth token. */
export function tokenKeyFor(id: string): string {
  return id === PRIMARY_ACCOUNT ? TOKEN_KEY : `CLAUDE_CODE_OAUTH_TOKEN_${id.toUpperCase()}`;
}
/** The secret key holding a given account's optional human label. */
export function labelKeyFor(id: string): string {
  return id === PRIMARY_ACCOUNT ? PRIMARY_LABEL_KEY : `CLAUDE_ACCOUNT_LABEL_${id.toUpperCase()}`;
}
/**
 * The config key holding a given account's weekly-limit reset schedule — the
 * day-of-week + time-of-day at which Anthropic resets THIS account's weekly
 * usage window. Each account resets on its own schedule, so this is per-account.
 * Value format: "<dow> <HH:MM>" where dow is 0–6 (0=Sunday, JS getDay) and HH:MM
 * is 24-hour wall-clock in America/New_York (the user reads Claude's "Resets Sun
 * 7:59 PM" in NY time). Unset → the usage endpoint falls back to a rolling 7-day
 * window. Config, not secret. */
const PRIMARY_RESET_KEY = "CLAUDE_ACCOUNT_WEEKLY_RESET";
export function resetKeyFor(id: string): string {
  return id === PRIMARY_ACCOUNT ? PRIMARY_RESET_KEY : `CLAUDE_ACCOUNT_WEEKLY_RESET_${id.toUpperCase()}`;
}

/** A parsed weekly-reset schedule (NY wall-clock). */
export interface WeeklyReset {
  /** 0–6, 0 = Sunday (JS getDay convention). */
  dow: number;
  /** "HH:MM", 24-hour, America/New_York. */
  time: string;
}

/** Parse a stored "<dow> <HH:MM>" reset value; null on empty/malformed (fail-safe:
 *  a bad value means "no schedule", i.e. fall back to the rolling window). */
export function parseWeeklyReset(raw: string | null | undefined): WeeklyReset | null {
  const v = raw?.trim();
  if (!v) return null;
  const m = /^([0-6])\s+([0-2]?\d):([0-5]\d)$/.exec(v);
  if (!m) return null;
  const dow = Number(m[1]);
  const hh = Number(m[2]);
  if (hh > 23) return null;
  return { dow, time: `${String(hh).padStart(2, "0")}:${m[3]}` };
}

/** America/New_York offset (ms, e.g. -4h in EDT) at a given instant. Compares the
 *  same instant formatted as UTC vs NY — the difference is the zone offset, DST and
 *  all, without a tz library. */
function nyOffsetMs(instant: Date): number {
  const utc = new Date(instant.toLocaleString("en-US", { timeZone: "UTC" }));
  const ny = new Date(instant.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return ny.getTime() - utc.getTime();
}

/**
 * The UTC epoch (ms) of the most recent past weekly reset, given a schedule in NY
 * wall-clock and "now" (ms). Finds the latest instant whose NY weekday = `dow` and
 * NY time = the schedule time, at or before now. DST-safe: the reset time (never
 * near the 2 AM transition in practice) sits in one offset regime, so a single
 * offset correction is exact. Exported for the usage endpoint's weekly window.
 */
export function mostRecentWeeklyReset(reset: WeeklyReset, nowMs: number): number {
  const [hh, mm] = reset.time.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const nowDow = wdMap[get("weekday")] ?? 0;
  const y = Number(get("year"));
  const mo = Number(get("month")) - 1;
  const d = Number(get("day"));
  const nowH = Number(get("hour")) % 24;
  const nowMi = Number(get("minute"));
  let back = (nowDow - reset.dow + 7) % 7;
  // Reset day is today but its time hasn't passed yet → the current window opened a
  // week ago, not today.
  if (back === 0 && (nowH < hh || (nowH === hh && nowMi < mm))) back = 7;
  // Build the NY wall-clock instant (Date.UTC normalizes the day rollback) and shift
  // by the NY offset at that instant to get the true UTC epoch.
  const wallGuess = Date.UTC(y, mo, d - back, hh, mm);
  return wallGuess - nyOffsetMs(new Date(wallGuess));
}

/**
 * The ordered account ids the console can route to — `primary` first, then the
 * registry's extras (deduped, validated, never a second `primary`). This is the
 * single source of truth for both the switcher (describeAccounts) and the
 * server-side validation in threads.ts, so the two can never drift.
 */
export async function listAccountIds(): Promise<string[]> {
  const raw = (await getAppSecret(TOKEN_APP_SLUG, ACCOUNTS_REGISTRY_KEY, ACCOUNTS_REGISTRY_KEY))?.trim();
  const extras = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => ACCOUNT_ID_RE.test(s) && s !== PRIMARY_ACCOUNT)
    : DEFAULT_EXTRA_ACCOUNTS;
  // `automation` is always kept in the list, even if the operator's registry value
  // omits it: background work (analysis.ts) routes to it by id, so it must stay a
  // known, switchable account rather than silently vanishing from the switcher when
  // someone sets CLAUDE_ACCOUNTS to just their new id. Deduped, primary first.
  return [PRIMARY_ACCOUNT, ...Array.from(new Set([...DEFAULT_EXTRA_ACCOUNTS, ...extras]))];
}

export interface AccountInfo {
  /** The id stored on a thread and sent to loadAccountToken. */
  id: string;
  /** Operator-set label, or null to let the client pick a default for this id. */
  label: string | null;
  /** True when this account's OAuth token is actually configured. The switcher
   *  disables an unconfigured account so the user can't route a thread to a
   *  phantom credential that would silently fall back to the primary token. */
  configured: boolean;
  /** This account's weekly-limit reset schedule (NY wall-clock), or null when the
   *  operator hasn't set one — the usage endpoint then uses a rolling 7-day window. */
  weeklyReset: WeeklyReset | null;
}

/**
 * Describe the accounts the console can run on — what the switcher lists.
 *
 * Reads only the presence of each token (never the token itself) plus the optional
 * labels. The automation account being unconfigured is normal: loadAccountToken
 * falls back to the primary token, so it is reported `configured:false` and the UI
 * greys it out rather than offering a route that does nothing.
 */
export async function describeAccounts(): Promise<AccountInfo[]> {
  const ids = await listAccountIds();
  return Promise.all(
    ids.map(async (id) => {
      const [tok, label, reset] = await Promise.all([
        getAppSecret(TOKEN_APP_SLUG, tokenKeyFor(id), tokenKeyFor(id)),
        getAppSecret(TOKEN_APP_SLUG, labelKeyFor(id), labelKeyFor(id)),
        getAppSecret(TOKEN_APP_SLUG, resetKeyFor(id), resetKeyFor(id)),
      ]);
      return {
        id,
        label: label?.trim() || null,
        configured: !!tok?.trim(),
        weeklyReset: parseWeeklyReset(reset),
      };
    }),
  );
}

/**
 * Resolve the subscription token for a run's account.
 *
 * Returns the token together with the key it came from, so a failure message can
 * name the exact secret the operator has to fix. The automation account falls back
 * to the primary token when its own key is unset — automated work keeps running
 * rather than failing loudly on a credential that hasn't been added yet.
 */
async function loadAccountToken(
  account: string | null | undefined,
): Promise<{ token: string | null; key: string }> {
  const id = (account ?? "").trim().toLowerCase();
  if (id && id !== PRIMARY_ACCOUNT && ACCOUNT_ID_RE.test(id)) {
    const key = tokenKeyFor(id);
    const tok = (await getAppSecret(TOKEN_APP_SLUG, key, key))?.trim() || null;
    if (tok) return { token: tok, key };
    // Fall through to the primary token: a non-primary account whose own key is
    // unset keeps running rather than failing loudly on a credential that hasn't
    // been added yet (the original automation-account behavior, now for any id).
  }
  const primary = (await getAppSecret(TOKEN_APP_SLUG, TOKEN_KEY, TOKEN_KEY))?.trim() || null;
  return { token: primary, key: TOKEN_KEY };
}

/**
 * Locate the Claude Code binary.
 *
 * Railway's start command is `node dist/index.js` rather than an npm script, so
 * node_modules/.bin is NOT on PATH — resolving the dependency's binary by
 * absolute path is what makes this work on the deployed host. CLAUDE_CLI_PATH
 * overrides everything (a system-wide install, or a pinned build), and bare
 * "claude" stays as the last resort for a shell where it is on PATH.
 */
function resolveCli(): string {
  const explicit = process.env.CLAUDE_CLI_PATH;
  if (explicit) return explicit;
  const local = path.join(process.cwd(), "node_modules", ".bin", "claude");
  if (existsSync(local)) return local;
  return "claude";
}

/**
 * Pre-accept the workspace trust dialog for a directory.
 *
 * Claude Code refuses to honor a project's .claude/settings.json — its
 * permissions.allow entries AND its hooks — until the workspace is "trusted".
 * Interactively that is a one-time dialog; in non-interactive `-p` mode the
 * dialog never shows, so the CLI prints "this workspace has not been trusted"
 * and IGNORES the settings. The remedy the warning itself names is to set
 * projects["<dir>"].hasTrustDialogAccepted in the home ~/.claude.json — verified
 * against the CLI binary (the exact keys are `hasTrustDialogAccepted` and
 * `hasCompletedProjectOnboarding`). There is no env var or flag that trusts a
 * directory, so this file edit is the only path.
 *
 * Best-effort and merge-only: the home file also holds the oauth account and
 * other state, so we read-modify-write it and never overwrite. An atomic rename
 * keeps a concurrent reader from ever seeing a half-written file; the only race
 * is two brand-new workspaces trusted at the same instant losing one entry, which
 * self-heals on that thread's next turn (the warning is merely cosmetic under
 * bypassPermissions anyway). Any failure is swallowed — trust is a quality-of-life
 * fix, never a reason to fail a run.
 */
async function trustWorkspace(dir: string): Promise<void> {
  try {
    // The CLI reads its home config from CLAUDE_CONFIG_DIR when set (verified
    // against the binary: the config dir resolves as `CLAUDE_CONFIG_DIR ??
    // join(homedir(), ".claude")` and `.claude.json` is written inside it). The
    // child inherits the backend's env, so when the operator points the config
    // dir at a Railway Volume (to keep engine sessions across deploys), the
    // trust entry must be written THERE or it would never be seen.
    const cfgDir = process.env.CLAUDE_CONFIG_DIR?.trim();
    const file = cfgDir
      ? path.join(cfgDir, ".claude.json")
      : path.join(os.homedir(), ".claude.json");
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      // Missing or unreadable — start from an empty config rather than give up.
    }
    const projects =
      cfg.projects && typeof cfg.projects === "object"
        ? (cfg.projects as Record<string, Record<string, unknown>>)
        : {};
    const existing =
      projects[dir] && typeof projects[dir] === "object" ? projects[dir] : {};
    // Already trusted → no write, so the steady state does zero disk I/O.
    if (existing.hasTrustDialogAccepted === true) return;
    projects[dir] = {
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    };
    cfg.projects = projects;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
    await rename(tmp, file);
  } catch (e) {
    console.error(
      "[claude/runner] could not trust workspace:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Appended to every conversation turn's system prompt.
 *
 * The console must answer the user in Hebrew regardless of what language the
 * repo, the code, or the incoming message is in — the platform-wide standing
 * preference (see the repo CLAUDE.md). A CLAUDE.md line alone drifted to English
 * mid-conversation, and it only loads at all for a run that clones this repo;
 * a plain chat thread with no repo never sees it. Passing the rule as an
 * `--append-system-prompt` on EVERY invocation makes it hold for every thread,
 * repo-backed or not, on the first turn and each resumed one. Timezone is pinned
 * here for the same reason (the user is in New York).
 */
const HEBREW_DIRECTIVE =
  "השב תמיד למשתמש בעברית, בכל תשובה, ללא קשר לשפת ההודעה, הקוד או ההוראות. " +
  "קוד, מזהים, נתיבים ופקודות נשארים באנגלית — רק הטקסט המופנה למשתמש הוא בעברית. " +
  "הצג כל תאריך ושעה למשתמש באזור הזמן America/New_York.";

/**
 * Live children, keyed by run id — what makes a turn cancellable.
 *
 * In-memory, so it is correct only for the process that owns the run. That is
 * exactly true today (the route fires executeRun in-process), and the day a queue
 * worker arrives the cancel path has to move with it. Recorded here rather than
 * discovered later.
 */
const running = new Map<string, ReturnType<typeof spawn>>();

/**
 * Runs THIS process has taken responsibility for, from the first line of
 * executeRun until it returns — a superset of `running` that also covers the
 * pre-spawn window (cloning the repo, minting app access) before a child exists.
 * The recoverer (recover.ts) reads it through isRunLive to know a run is being
 * handled here and must not be treated as orphaned, even mid-clone.
 */
const inFlight = new Set<string>();

/**
 * Is this run being executed by THIS process right now? True from the moment
 * executeRun is entered (even before the child spawns) until it returns. In-memory,
 * so it answers only for this process — which is exactly what the recoverer needs:
 * a run NOT live here, stuck `running`, is a run whose process died (a restart), so
 * it is safe to re-execute. The single-instance assumption is the same one the
 * cancel path documents above; a horizontally-scaled backend would need a
 * cross-instance signal (see recover.ts).
 */
export function isRunLive(runId: string): boolean {
  return inFlight.has(runId) || running.has(runId);
}

/**
 * Stop a turn the user asked to stop. Returns false when this process has no live
 * child for that id — the caller answers honestly instead of claiming success.
 */
export function cancelRun(runId: string): boolean {
  const child = running.get(runId);
  if (!child) return false;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (running.has(runId)) child.kill("SIGKILL");
  }, SIGKILL_GRACE_MS);
  return true;
}

/** Hard ceiling on a single run, so a hung process can't occupy the host forever.
 *  45 minutes, not the original 15: real turns (a full audit, a slow build+merge)
 *  legitimately run past 15, and killing them meant the recoverer REPLAYED the
 *  whole turn — duplicating side effects. Raising this is safe because liveness
 *  is judged by the 20s heartbeat (recover.ts), never by this ceiling. */
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
/** The effective per-run ceiling, honoring the env override. Exported so the
 *  recoverer can reason about it (a live run is SIGKILLed by this, so anything
 *  stuck far past it has no process behind it). */
export const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
/** How long a timed-out child gets to exit on SIGTERM before it is SIGKILLed. */
const SIGKILL_GRACE_MS = 10_000;
/** Liveness ping: while a child runs, its claude_runs.updated_at is bumped this
 *  often even when the stream is quiet (a long tool call emits no events). That
 *  turns updated_at into a true "process alive" signal — the UI's live status line
 *  reads it to tell an active run from a dead one, and the recoverer uses the same
 *  staleness to decide a run was orphaned by a restart. 20s is frequent enough that
 *  a healthy run never looks stale, cheap enough to be negligible. */
const HEARTBEAT_MS = 20_000;
/** Events are flushed in batches — a write per event would serialize the stream.
 *  Tuned down from 25/1000ms to 8/500ms so streamed output reaches the DB (and the
 *  polling UI) about twice as fast — the perceived-speed win. Still a batch, so a
 *  chatty turn is not one insert per event; the cost is roughly 2x more small
 *  inserts on a live turn, which the events table absorbs comfortably. */
const FLUSH_EVERY = 8;
const FLUSH_INTERVAL_MS = 500;
/** Text is cheap but not free: keep rows bounded, keep media as URLs elsewhere. */
const MAX_TEXT = 20_000;
const MAX_PAYLOAD_CHARS = 100_000;

type EventKind =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system"
  | "result"
  | "error";

type PendingEvent = {
  seq: number;
  kind: EventKind;
  text: string | null;
  tool_name: string | null;
  payload: unknown;
};

/**
 * In-process live event bus — what the NDJSON stream route (routes.ts) taps so the
 * screen can render output the moment it is parsed, without waiting for the DB
 * batch flush (~500ms) + the client poll (~900ms). Emits per run:
 *   `ev:<runId>`  a redacted, display-shaped event { seq, kind, text, tool_name, created_at }
 *   `end:<runId>` the run reached a terminal state — the stream route closes on it.
 * In-memory on purpose: correct for the single process that owns the child (the
 * same single-instance assumption the cancel path and recoverer document), and a
 * subscriber on another instance simply gets nothing and falls back to polling.
 */
export const runEventBus = new EventEmitter();
// Many concurrent viewers of many runs are legitimate; the default 10 would warn.
runEventBus.setMaxListeners(200);

/** The display-shaped live event the bus emits — mirrors what the poll returns
 *  from claude_run_events, so the client merges both sources by seq. */
export interface LiveEvent {
  seq: number;
  kind: string;
  text: string | null;
  tool_name: string | null;
  created_at: string;
}

/**
 * The subscription window ran out mid-run. Stored as a machine-readable prefix on
 * claude_runs.error while the row stays 'queued', so (a) the recoverer retries it
 * on a slow cadence instead of burning its 2 resume attempts immediately, and (b)
 * the screen can tell "waiting for the usage window" from "starting". A prefix on
 * an existing column, not a new status value, so no migration is needed and every
 * existing state machine (dispatch, cancel, screens) keeps working unchanged.
 */
export const USAGE_LIMIT_SENTINEL = "usage-limit-wait:";
/** When the reset moment could be parsed out of the CLI's message, it rides in
 *  the sentinel as `usage-limit-wait:until=<iso>; …` — the recoverer then waits
 *  for THAT moment instead of blind 15-minute probing, and the screen can show
 *  the user when work will resume. Absent (unparseable message) → the recoverer
 *  falls back to the 15-minute cadence. */
export const USAGE_UNTIL_RE = /^usage-limit-wait:until=([0-9TZ:.+-]+);/;

/**
 * Extract the usage-window reset time from the CLI's failure text, when present.
 *
 * Shapes recognized (most-specific first):
 *   1. "…usage limit reached|1750000000" — a unix epoch (s or ms) after a pipe,
 *      the API's machine-readable form.
 *   2. An ISO timestamp within a few words of "reset".
 *   3. Dated wall-clock: "resets Aug 5, 10am (UTC)" — a month/day/time in a named
 *      zone (a WEEKLY reset can be days out; scanned over 8 days).
 *   4. Time-only wall-clock: "resets 5am (UTC)" / "resets at 3am (America/New_York)"
 *      — the "at" is optional (the current CLI drops it); scanned over 26h.
 *
 * Shapes 3–4 resolve to the NEXT instant whose wall clock in that zone matches
 * (minute-step scan — exact, and immune to DST/offset arithmetic mistakes).
 *
 * Returns null for anything else, or for a value outside (now-5min, now+8d) —
 * a nonsense parse must not schedule a retry into next year. Null simply means
 * the recoverer keeps its blind 15-minute cadence, so a wrong *format* costs
 * nothing; only a wrong *accepted value* would, hence the clamp.
 */
export function parseUsageResetTime(text: string, nowMs = Date.now()): Date | null {
  const clamp = (d: Date): Date | null => {
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    if (t < nowMs - 5 * 60 * 1000 || t > nowMs + 8 * 24 * 60 * 60 * 1000) return null;
    return d;
  };

  // Each pattern FALLS THROUGH on a rejected value (clamp null), so a stray
  // 10-digit id after a pipe cannot mask a perfectly good "resets …" later
  // in the same text.
  const epoch = text.match(/\|\s*(\d{10,13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    const d = clamp(new Date(epoch[1].length >= 13 ? n : n * 1000));
    if (d) return d;
  }

  const iso = text.match(
    /reset[^.\n]{0,40}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    // A zoneless timestamp is read as UTC, not server-local time — the CLI's
    // machine timestamps are UTC, and a non-UTC host would silently shift it.
    const raw = iso[1].replace(" ", "T") + (iso[2] ? "" : "Z");
    const d = clamp(new Date(raw));
    if (d) return d;
  }

  const hourOf = (h: string, ap: string): number => {
    let hour = Number(h) % 12;
    if (ap.toLowerCase() === "pm") hour += 12;
    return hour;
  };

  // Scan forward minute-by-minute for the first instant whose wall clock in
  // `zone` matches the given components. month/day are optional (a time-only
  // reset scans 26h; a dated one scans 8 days — a weekly reset can be days out).
  // We ASK Intl what the wall clock is at each instant, so DST/offset arithmetic
  // is never done by hand.
  const scanZone = (
    zone: string,
    hour: number,
    minute: number,
    month: number | null,
    day: number | null,
  ): Date | null => {
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return null; // an unknown zone name — don't guess
    }
    const horizonMin = month !== null ? 8 * 24 * 60 : 26 * 60;
    const start = Math.ceil(nowMs / 60_000) * 60_000;
    for (let i = 0; i <= horizonMin; i++) {
      const parts = fmt.formatToParts(new Date(start + i * 60_000));
      const get = (ty: string): number => Number(parts.find((p) => p.type === ty)?.value);
      if ((get("hour") % 24) !== hour || get("minute") !== minute) continue;
      if (month !== null && get("month") !== month + 1) continue;
      if (day !== null && get("day") !== day) continue;
      return clamp(new Date(start + i * 60_000));
    }
    return null;
  };

  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  // 3. Dated wall-clock: "resets Aug 5, 10am (UTC)" / "reset Aug 5 at 10:30pm (Zone)".
  const dated = text.match(
    /resets?\s+(?:at\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i,
  );
  if (dated) {
    const mon = MONTHS[dated[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      const d = scanZone(
        dated[6].trim(),
        hourOf(dated[3], dated[5]),
        dated[4] ? Number(dated[4]) : 0,
        mon,
        Number(dated[2]),
      );
      if (d) return d;
    }
  }

  // 4. Time-only wall-clock ("at" optional): "resets 5am (UTC)" / "resets at 3am (Zone)".
  const wall = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (wall) {
    const d = scanZone(
      wall[4].trim(),
      hourOf(wall[1], wall[3]),
      wall[2] ? Number(wall[2]) : 0,
      null,
      null,
    );
    if (d) return d;
  }

  return null;
}
/** Matched against the CLI's failure text. Narrow on purpose: an ordinary API
 *  error must NOT be retried in a loop — a broad match (e.g. bare "rate limit")
 *  would park a turn whose SHELL output merely mentioned "GitHub API rate limit"
 *  and replay it every 15 minutes for a day.
 *
 *  The CLI has used two families of phrasing for subscription exhaustion:
 *    - older: "Claude … usage limit reached" / "…limit will reset at…"
 *    - current (2026-08): "You've hit your weekly limit · resets Aug 5, 10am (UTC)"
 *      / "You've hit your session limit · resets 5am (UTC)".
 *  Both must match, or the run lands as `failed` and the recoverer never resumes
 *  it — which is exactly what happened to every usage-limited run before this fix
 *  (0 parked rows, 9 `failed` rows carrying the message). The new alternative is
 *  kept narrow — only the three CONFIRMED subscription phrasings
 *  ("your weekly/session/usage limit"), a shape a GitHub/API rate-limit message
 *  ("API rate limit exceeded") never has. Deliberately NOT "daily"/"N-hour":
 *  those are unconfirmed for this CLI and would only widen the false-park surface
 *  (a failed run merely quoting a third-party "reached your daily limit" would be
 *  parked and blind-probed for hours). "session limit" already covers the CLI's
 *  short (5-hour) window. */
const USAGE_LIMIT_RE =
  /claude\s+(?:ai\s+)?usage limit|usage limit reached|limit will reset|(?:hit|hits|reached|exceeded)\s+your\s+(?:weekly|session|usage)\s+limit/i;

/** True when the CLI's failure text is a subscription usage-limit stop (which the
 *  recoverer should PARK and resume), not an ordinary error the user must resend.
 *  Exported so the regression test pins the real phrasings against this exact
 *  predicate. */
export function detectUsageLimit(text: string): boolean {
  return USAGE_LIMIT_RE.test(text);
}

function truncate(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  return v.length > max ? `${v.slice(0, max)}\n…[truncated]` : v;
}

/** Keep `payload` useful without letting one giant tool result bloat the table. */
function safePayload(raw: unknown): unknown {
  try {
    const s = JSON.stringify(raw);
    if (s.length <= MAX_PAYLOAD_CHARS) return raw;
    return { truncated: true, size: s.length, head: s.slice(0, 2000) };
  } catch {
    return { unserializable: true };
  }
}

/**
 * Flatten one stream-json line into the events we store.
 *
 * Deliberately permissive: the raw line is always kept in `payload`, so a shape
 * we don't recognize is still recorded in full rather than dropped. That matters
 * because the stream format is Claude Code's, not ours — it can gain fields.
 */
function mapLine(line: unknown, nextSeq: () => number): PendingEvent[] {
  const obj = (line ?? {}) as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  const out: PendingEvent[] = [];

  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if ((type === "assistant" || type === "user") && Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      const partType = typeof part?.type === "string" ? part.type : "";
      if (partType === "text") {
        out.push({
          seq: nextSeq(),
          kind: type === "assistant" ? "assistant" : "user",
          text: truncate(part.text),
          tool_name: null,
          payload: safePayload(part),
        });
      } else if (partType === "tool_use") {
        out.push({
          seq: nextSeq(),
          kind: "tool_use",
          text: truncate(JSON.stringify(part.input ?? {})),
          tool_name: typeof part.name === "string" ? part.name : null,
          payload: safePayload(part),
        });
      } else if (partType === "tool_result") {
        const c = part.content;
        out.push({
          seq: nextSeq(),
          kind: "tool_result",
          text: truncate(typeof c === "string" ? c : JSON.stringify(c ?? "")),
          tool_name: null,
          payload: safePayload(part),
        });
      } else {
        out.push({
          seq: nextSeq(),
          kind: type === "assistant" ? "assistant" : "user",
          text: null,
          tool_name: null,
          payload: safePayload(part),
        });
      }
    }
    return out;
  }

  const kind: EventKind =
    type === "result" ? "result" : type === "system" ? "system" : "system";
  out.push({
    seq: nextSeq(),
    kind,
    text: truncate(
      typeof obj.result === "string" ? obj.result : obj.subtype ? String(obj.subtype) : null,
    ),
    tool_name: null,
    payload: safePayload(obj),
  });
  return out;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Pull the usage figures out of the stream's `result` event.
 *
 * Token totals are summed across `modelUsage` rather than read from the
 * top-level `usage` block, because a single run can touch more than one model —
 * a main turn on Sonnet plus a Haiku side task, say — and the top-level block
 * reports only the main one. `total_cost_usd` already covers every model, so it
 * is taken as given.
 *
 * On a subscription these runs are not billed per token; the cost figure is the
 * engine's equivalent-API estimate and is stored as a consumption measure only.
 */
function usageFromResult(result: Record<string, unknown> | null) {
  if (!result) return {};

  const models = (result.modelUsage ?? null) as Record<string, Record<string, unknown>> | null;
  const top = (result.usage ?? {}) as Record<string, unknown>;

  let input: number | null = null;
  let output: number | null = null;
  let cacheRead: number | null = null;
  let cacheCreate: number | null = null;

  if (models && typeof models === "object") {
    let i = 0;
    let o = 0;
    let cr = 0;
    let cc = 0;
    for (const m of Object.values(models)) {
      i += finiteOrNull(m?.inputTokens) ?? 0;
      o += finiteOrNull(m?.outputTokens) ?? 0;
      cr += finiteOrNull(m?.cacheReadInputTokens) ?? 0;
      cc += finiteOrNull(m?.cacheCreationInputTokens) ?? 0;
    }
    input = i;
    output = o;
    cacheRead = cr;
    cacheCreate = cc;
  } else {
    input = finiteOrNull(top.input_tokens);
    output = finiteOrNull(top.output_tokens);
    cacheRead = finiteOrNull(top.cache_read_input_tokens);
    cacheCreate = finiteOrNull(top.cache_creation_input_tokens);
  }

  return {
    total_cost_usd: finiteOrNull(result.total_cost_usd),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    num_turns: finiteOrNull(result.num_turns),
    duration_ms: finiteOrNull(result.duration_ms),
    model_usage: models,
  };
}

/**
 * Execute a queued run to completion. Resolves once the run row reaches a
 * terminal status — it never throws at the caller, because the run's own
 * `status`/`error` columns are the report, and callers fire this and move on.
 *
 * This wrapper exists for ONE reason: the cloned workspace holds the GitHub token
 * in its .git/config, so it must be deleted on every exit path — including an
 * unexpected throw anywhere in the body. A `finally` here is the only structure
 * that guarantees that; scattered cleanup calls cannot. The holder is what lets
 * the finally reach a workspace the inner function created.
 */
export async function executeRun(runId: string): Promise<void> {
  // Claim the run for THIS process from the very first line — before the clone, the
  // app-access mint, anything — so the recoverer never mistakes a run we are setting
  // up for an orphaned one and re-executes it in parallel (isRunLive covers this
  // whole window, not just the post-spawn one that `running` covers).
  inFlight.add(runId);
  try {
    await executeRunBody(runId);
  } catch (e) {
    // An unexpected throw would otherwise leave the row 'running' — a live status
    // the screen polls forever. Record it as the failure it is.
    const message = e instanceof Error ? e.message : String(e);
    console.error("[claude/runner] unexpected failure:", message);
    const { error } = await db
      .from("claude_runs")
      .update({
        status: "failed",
        error: truncate(message, 4000),
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      // Only from a non-terminal state: a run that already finished must not be
      // rewritten by a throw in the teardown that followed it.
      .in("status", ["queued", "running"]);
    if (error) console.error("[claude/runner] could not record failure:", error.message);
  } finally {
    inFlight.delete(runId);
    // Whatever path ended this execution (finish, park, throw), tell any open
    // live stream it is over so the route closes instead of idling to timeout.
    runEventBus.emit(`end:${runId}`);
  }
}

async function executeRunBody(runId: string): Promise<void> {
  const { data: run, error: loadError } = await db
    .from("claude_runs")
    .select("id, prompt, cwd, status, model, effort, repo, git_branch, thread_id, created_by, org_id, claude_account")
    .eq("id", runId)
    .maybeSingle();

  if (loadError) {
    console.error("[claude/runner] load failed:", loadError.message);
    return;
  }
  if (!run) {
    console.error("[claude/runner] run not found:", runId);
    return;
  }
  if (run.status !== "queued") {
    // Idempotent: a retry or a duplicate trigger must not run the same row twice.
    console.warn(`[claude/runner] run ${runId} is '${run.status}', not queued — skipping`);
    return;
  }

  const finish = async (fields: Record<string, unknown>) => {
    const { error } = await db
      .from("claude_runs")
      .update({ ...fields, ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", runId);
    if (error) console.error("[claude/runner] finish update failed:", error.message);
  };

  // Trimmed because this value is pasted by a human through an admin form, where a
  // stray newline or space rides along easily and would be sent verbatim. The key
  // depends on the run's account: automated runs route to the second subscription.
  const { token, key: tokenKey } = await loadAccountToken(run.claude_account);
  if (!token) {
    // Fail loudly rather than let Claude Code fall through to a billed credential.
    await finish({
      status: "failed",
      error:
        `${tokenKey} is not configured. Generate one with ` +
        "`npx @anthropic-ai/claude-code setup-token` (it authenticates with the Claude " +
        `subscription), then save it under /admin/apps/${TOKEN_APP_SLUG}/secrets — or ` +
        "set an environment variable of the same name on the backend.",
    });
    return;
  }

  // A run that names a repo gets a real working copy of it. The clone happens
  // BEFORE the run is marked running: a repo we cannot clone is a setup failure,
  // and recording it as a failed run (rather than a run that started and died) is
  // what makes the cause readable.
  // The conversation this turn belongs to, and the engine session to resume into.
  // A thread whose session_id is already set means this is a FOLLOW-UP: the engine
  // still holds the history, so the turn is resumed rather than started, and the
  // prompt carries only what the user just said.
  let resumeSession: string | null = null;
  // Split-child inheritance, read on the FIRST turn only (session_id still null):
  //   forkFromSession — method A: resume the PARENT's session with --fork-session.
  //   seedContext     — method B: prepend the handover to the first prompt.
  let forkFromSession: string | null = null;
  let seedContext: string | null = null;
  // A method-A fork child must run in the PARENT's working directory, because the
  // engine stores sessions per project dir — both the parent session it forks from
  // and the forked session it then owns live there. Its own dir would find neither.
  // workspace_thread_id carries that directory key durably (it survives the parent's
  // deletion — see the migration), so it is the authority on where turns run.
  let workspaceThreadId: string | null = run.thread_id;
  if (run.thread_id) {
    const { data: thread, error: tErr } = await db
      .from("claude_threads")
      .select("session_id, fork_from_session, seed_context, workspace_thread_id")
      .eq("id", run.thread_id)
      .maybeSingle();
    if (tErr) console.error("[claude/runner] thread fetch failed:", tErr.message);
    resumeSession = thread?.session_id ?? null;
    if (thread?.workspace_thread_id) workspaceThreadId = thread.workspace_thread_id;
    // Only when the thread has no session of its own yet — a split child's first
    // turn. Once it has resumed once, it owns a session and these are irrelevant.
    if (!resumeSession) {
      forkFromSession = thread?.fork_from_session ?? null;
      seedContext = thread?.seed_context ?? null;
    }
  }

  // ── the working directory ──
  //
  // STABLE PER THREAD, not per run. Engine sessions are stored per project
  // directory, so a fresh temp dir on every turn would make `--resume <id>` unable
  // to find the session it was handed — the conversation would silently lose its
  // memory. Reusing the directory is also what lets turn 2 see the files turn 1
  // edited. It is NOT deleted at the end of a turn; it is deleted when the thread
  // is deleted, and swept by age.
  //
  // Held for the whole function, not just the clone: anything the run prints can
  // echo a tokenised remote URL, so the final error text has to be redacted too.
  // Fetched UNCONDITIONALLY (best-effort): even a turn with no repo pre-selected
  // rides the git credential helper, so Claude can `git clone`/`push` any repo the
  // token reaches on demand — the whole point of "it should just have access". Null
  // when unconfigured, which degrades to no git auth exactly as before.
  let ghToken: string | null = await getGitHubToken();
  const workDir = workspaceThreadId ? await threadWorkspace(workspaceThreadId) : null;

  if (run.repo) {
    if (!ghToken) {
      await finish({
        status: "failed",
        error:
          `This run targets ${run.repo} but GITHUB_TOKEN is not configured. Save a ` +
          "GitHub personal access token with 'repo' scope under " +
          "/admin/apps/smrttask/secrets (key: GITHUB_TOKEN).",
      });
      return;
    }
    if (!workDir) {
      await finish({
        status: "failed",
        error: "a run against a repo must belong to a thread (it needs a stable working directory)",
      });
      return;
    }
    try {
      // Idempotent: clones on the thread's first repo turn, reuses the checkout
      // after that.
      await ensureClone(path.join(workDir, run.repo.split("/")[1]), run.repo, run.git_branch, ghToken);
    } catch (e) {
      await finish({
        status: "failed",
        error: truncate(redact(e instanceof Error ? e.message : String(e), ghToken), 4000),
      });
      return;
    }
  }

  // Where the turn actually runs: the repo checkout when there is one, otherwise
  // the thread's own directory. Never process.cwd() — that is the deployed source
  // tree, which a chat turn has no business reading or touching.
  const cwd = run.repo && workDir ? path.join(workDir, run.repo.split("/")[1]) : workDir;

  // Wall-clock start of the whole turn (clone and prep included) — what the
  // completion push notification measures "was this long enough to notify" by.
  const startedWallMs = Date.now();
  const { error: startError } = await db
    .from("claude_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Recorded so the run says where it actually worked, not where it was asked to.
      ...(cwd ? { cwd } : {}),
      resumed_session: resumeSession,
    })
    .eq("id", runId);
  if (startError) {
    console.error("[claude/runner] could not mark running:", startError.message);
    // Recorded as failed, not left as-is: 'queued' is a live status the screen polls
    // forever, so a run that can never start would spin in the UI for good.
    await finish({ status: "failed", error: truncate(startError.message, 4000) });
    return;
  }

  // Subscription auth must win — see the billing note in this file's header. The
  // git credential helper rides along so a `git push` inside the turn authenticates
  // without the token ever being written into the checkout.
  const env: NodeJS.ProcessEnv = { ...gitEnvForRun(ghToken), CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Railway runs this backend as root inside an isolated, ephemeral container.
  // Claude Code refuses bypassPermissions (and the equivalent
  // --dangerously-skip-permissions) when running as root unless it sees a sandbox
  // marker — verified against the CLI binary, whose guard is exactly
  // `getuid()===0 && IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP`. Without this,
  // every repo run dies on start with "--dangerously-skip-permissions cannot be
  // used with root/sudo privileges for security reasons". The container IS the
  // sandbox (nothing else shares it, and it is torn down after the run), so we
  // declare it. Scoped to this child's env only — the backend process is untouched.
  env.IS_SANDBOX = "1";

  // Callback channel for the autonomy gate. The in-app Claude runs with full shell in
  // its checkout (see the permission mode below), so for a DESTRUCTIVE migration it
  // must NOT apply the SQL itself — it calls the machine-to-machine approval endpoint
  // to open a human-approval card and stops. These are what let it make that call from
  // inside the run: which org/thread/run it is, the shared internal secret, and the
  // backend base URL. Only set when all the pieces exist, so a misconfigured backend
  // degrades to "the gate isn't reachable" rather than a half-formed request.
  const internalSecret = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET || "";
  const backendUrl = process.env.SMRTESY_PUBLIC_URL || process.env.SMRTESY_BACKEND_URL || "";
  if (internalSecret && backendUrl) {
    env.SMRTESY_BACKEND_URL = backendUrl;
    env.SMRTBOT_INTERNAL_SECRET = internalSecret;
    env.CLAUDE_RUN_ID = run.id;
    env.CLAUDE_ORG_ID = run.org_id;
    if (run.thread_id) env.CLAUDE_THREAD_ID = run.thread_id;
  }

  // Supabase migration credentials. Without the access token a run can WRITE a
  // migration file but has no way to APPLY it (the missing plumbing this fixes). The
  // apply goes through the Management API query endpoint (see the constant's doc), so
  // only the access token is needed — no db password. Injected only when the token
  // exists, so a project that hasn't set it degrades to "can't apply, ask the user"
  // (composePrompt phrases that honestly via the same check). The token is added to
  // redactSecrets below so a run's `env`/`curl -v`/stack trace can't leak it into the
  // stored transcript. The apply run enqueued after a destructive approval runs through
  // this same path, so it is covered by one injection point.
  const supabaseTokenClean =
    (await getAppSecret(TOKEN_APP_SLUG, SUPABASE_TOKEN_KEY, SUPABASE_TOKEN_KEY))?.trim() || null;
  if (supabaseTokenClean) {
    env.SUPABASE_ACCESS_TOKEN = supabaseTokenClean;
    env.SUPABASE_PROJECT_ID =
      (await getAppSecret(TOKEN_APP_SLUG, SUPABASE_PROJECT_ID_KEY, SUPABASE_PROJECT_ID_KEY))?.trim() ||
      SUPABASE_PROJECT_REF_DEFAULT;
  }

  // App access — a real short-lived session for the launching user, minted fresh
  // per turn, so the run can call the platform's own API the way the frontend does
  // (the env preamble in composePrompt tells it how). Minted every turn for every
  // run exactly as before — UNCHANGED behavior — but kicked off HERE as a promise so
  // its ~3 sequential Supabase auth round-trips overlap the attachment download and
  // workspace-trust below instead of running strictly before them (the prep-latency
  // win). Awaited further down, before the env vars that use it are set. Best-effort:
  // a mint failure just leaves the variables unset, and the run works as before.
  const appAccessPromise = run.created_by
    ? mintAppAccess(run.created_by)
    : Promise.resolve(null);

  // Attachments: downloaded into the working directory, then named in the prompt.
  // The engine reads files by path (its Read tool handles images too) — the CLI's
  // --file flag is for Anthropic Files API ids, NOT local paths, so pointing at
  // the path is the correct contract here, not a workaround.
  let promptText = run.prompt;
  // Method B handover: the seed goes in FRONT of the first message, so the child
  // opens knowing its topic. Prepended (not appended) so it reads as background the
  // message then acts on. Written back to the row too, so the stored prompt matches
  // what actually ran.
  //
  // The startsWith guard makes this idempotent across a re-execution: the recoverer
  // re-runs an orphaned turn from the SAME row, whose prompt already carries the
  // seed from the first attempt — without the guard each resume would prepend it
  // again, stacking `# רקע...` blocks and inflating the argv.
  if (seedContext && !resumeSession && !promptText.startsWith("# רקע מהשיחה הקודמת")) {
    promptText = `# רקע מהשיחה הקודמת\n\n${seedContext}\n\n---\n\n${promptText}`;
    const { error: sErr } = await db.from("claude_runs").update({ prompt: promptText }).eq("id", runId);
    if (sErr) console.error("[claude/runner] seed prompt update failed:", sErr.message);
  }
  if (cwd) {
    // Always re-materialize: a resumed run gets a fresh workspace, so the files must
    // be re-downloaded to disk even though the prompt already names them.
    const { paths, failures } = await materializeAttachments(runId, cwd);
    // But add the prompt SECTION only once — on a re-execution it is already there
    // (written back on the first attempt), and re-appending would duplicate it.
    const alreadyListed =
      promptText.includes("# קבצים מצורפים") || promptText.includes("(קבצים שלא נטענו:");
    if (!alreadyListed) {
      if (paths.length > 0) {
        promptText += `\n\n# קבצים מצורפים\n${paths.map((p) => `- ${p}`).join("\n")}`;
      }
      // Surfaced in the prompt rather than swallowed: the turn should know a file it
      // was told about is missing, instead of concluding the user sent nothing.
      if (failures.length > 0) {
        promptText += `\n\n(קבצים שלא נטענו: ${failures.join("; ")})`;
      }
      if (paths.length > 0 || failures.length > 0) {
        const { error: pErr } = await db
          .from("claude_runs")
          .update({ prompt: promptText })
          .eq("id", runId);
        if (pErr) console.error("[claude/runner] prompt update failed:", pErr.message);
      }
    }
  }

  // Trust the directory the turn runs in, so the CLI loads the repo's
  // .claude/settings.json (permissions + hooks) instead of printing
  // "workspace has not been trusted" and ignoring it. Non-interactive -p mode
  // never shows the dialog, so we pre-accept it — exactly what that warning asks
  // the operator to do by hand.
  if (cwd) await trustWorkspace(cwd);

  // Fold in the app-access result now (its Supabase round-trips overlapped the prep
  // above). Declared before buildArgs so its closure captures it. Same env vars as
  // before — only the moment they're computed moved.
  const appAccess = await appAccessPromise;
  if (appAccess) {
    env.SMRTESY_API_URL = appAccess.url;
    env.SMRTESY_API_TOKEN = appAccess.token;
    if (run.org_id) env.SMRTESY_ORG_ID = run.org_id;
    // Real-browser access: the helper script logs a headless Chromium into the
    // app as the user (same session as the API token, as cookies) and can post
    // screenshots back into this very turn — hence the run id. The helper is
    // shipped with the server build, next to this file's compiled form, so its
    // require('playwright') resolves from the server's own node_modules no
    // matter which workspace directory the turn runs in.
    if (appAccess.browser) {
      env.SMRTESY_APP_URL = appAccess.browser.appUrl;
      env.SMRTESY_BROWSER_COOKIES = JSON.stringify(appAccess.browser.cookies);
      env.SMRTESY_BROWSER_HELPER = BROWSER_HELPER_PATH;
      env.SMRTESY_RUN_ID = runId;
    }
  }

  const bin = resolveCli();
  const extra = (process.env.CLAUDE_RUN_EXTRA_ARGS || "").split(" ").filter(Boolean);
  const timeoutMs = RUN_TIMEOUT_MS;

  /**
   * The CLI args for one attempt. `resume` is a parameter, not a closed-over
   * constant, precisely so the same turn can be re-run as a fresh session when the
   * resume target turns out to be gone (the fallback below).
   */
  const buildArgs = (resume: string | null, fork = false): string[] => {
    // promptText is a POSITIONAL argument (`claude [options] [prompt]`), passed
    // LAST after a `--` separator (see the return below) — NOT here right after
    // `-p`. A prompt that starts with "-" (a Hebrew bullet list, "- …") sitting
    // among the options is parsed by the CLI as an unknown option and the whole
    // turn fails ("error: unknown option '- …'"); `--` forces everything after it
    // to be read as the prompt. Verified against the installed binary.
    const a = ["-p", "--output-format", "stream-json", "--verbose"];
    // Token-level deltas ride the stream as `stream_event` lines (verified
    // against the 2.1.220 binary: the flag requires --print + stream-json,
    // both present here). They feed the live NDJSON stream ONLY — the stdout
    // handler never stores them — which is what turns the console bubble from
    // paragraph-at-a-time into word-by-word, like claude.ai.
    a.push("--include-partial-messages");
    // THE line that makes a thread a conversation: resume the engine session the
    // thread already owns, so this turn sees every earlier turn. Without it each
    // message would start from nothing and the chat would have no memory.
    if (resume) a.push("--resume", resume);
    // Method A split ("take everything"): the child's first turn resumes the
    // PARENT's session and forks it — a new session id that starts with the whole
    // parent history and diverges. Only the first turn passes fork=true; afterwards
    // the child owns its own session and resumes it plainly.
    if (fork) a.push("--fork-session");
    // Omitted when unset rather than defaulted, so a run without a choice follows
    // the CLI's current default instead of being pinned to a model that will age.
    if (run.model) a.push("--model", run.model);
    if (run.effort) a.push("--effort", run.effort);
    // In a cloned workspace the run needs full agency: edit files, run the build,
    // git-merge to main, and apply a migration (curl to the Supabase Management API) —
    // the whole developer loop. Print mode cannot answer a permission prompt (an un-answerable
    // prompt is a denial), so anything short of bypassPermissions would silently block
    // shell and leave a repo run able only to read/edit. The operator chose "full
    // access, like a developer on the team" (autonomy-safety-gate.md), so repo runs
    // default to bypassPermissions. The real red line — a DESTRUCTIVE migration — is
    // NOT held here; it is held by the approval gate the run itself routes through
    // (env vars above), which is why widening shell here is safe. Skipped entirely
    // when the operator already set a permission flag in CLAUDE_RUN_EXTRA_ARGS, so
    // their choice always wins.
    if (run.repo && !extra.some((x) => x.startsWith("--permission-mode") || x === "--dangerously-skip-permissions")) {
      a.push("--permission-mode", "bypassPermissions");
    }
    // The browser helper (headless Chromium logged in as the user), pre-approved by
    // its literal absolute path. Under bypassPermissions above this is REDUNDANT —
    // full shell already covers `node <helper> …` — but it is kept as belt-and-braces
    // so the helper still runs if a run ever narrows the permission mode via
    // CLAUDE_RUN_EXTRA_ARGS. Both quoting spellings are listed because each produces
    // different literal command text. --allowedTools is additive with
    // --permission-mode and with any operator flags in `extra` (CLI docs, 2026-07-29).
    if (appAccess?.browser) {
      // Flag repeated per rule (not one flag with two values): repetition is
      // documented-additive, while variadic parsing of a second value is not.
      a.push("--allowedTools", `Bash(node ${BROWSER_HELPER_PATH}:*)`);
      a.push("--allowedTools", `Bash(node "${BROWSER_HELPER_PATH}":*)`);
    }
    // Open, unscoped web access on EVERY run — regular fetch/search for research,
    // plus the real browser (the helper above) when app-access minted one. A
    // repo run already has these under bypassPermissions, so this is redundant
    // there but harmless (--allowedTools is additive); the ones it actually
    // unblocks are the plain chat threads with no repo, which otherwise get the
    // CLI's default mode where an un-answerable -p prompt silently denies web
    // tools. Bare tool names (no domain filter) = allow all sites, which is the
    // "full browsing + full research" the operator asked for.
    a.push("--allowedTools", "WebSearch");
    a.push("--allowedTools", "WebFetch");
    // Force Hebrew (and New York time) on every turn — see HEBREW_DIRECTIVE.
    a.push("--append-system-prompt", HEBREW_DIRECTIVE);
    a.push(...extra);
    // The prompt goes LAST, behind `--`, so a "-"-leading message is read as the
    // positional prompt instead of an option. Must stay the final push.
    a.push("--", promptText);
    return a;
  };

  // seq / buffer / flush are shared across attempts on purpose: every attempt's
  // events land in the SAME run with one continuous seq, so the transcript is
  // honest about a fallback having happened rather than hiding the first try.
  let seq = 0;
  const nextSeq = () => ++seq;
  let buffer: PendingEvent[] = [];

  // Scrub EVERY secret this run's child holds — not just the GitHub token. The child
  // env also carries the shared internal secret (approval-gate callback), the
  // subscription OAuth token, the minted app-access session token, and — for migration
  // runs — the Supabase access token. A run with full shell can echo any of them (an
  // accidental `env`, a curl -v, a stack trace, git printing a tokenised URL). These
  // rows are the permanent transcript, so all of them are replaced with *** before
  // anything is stored. redact is a no-op for a null/empty value, so an unconfigured
  // secret costs nothing here.
  const redactSecrets = (s: string): string =>
    redact(
      redact(redact(redact(redact(s, ghToken), internalSecret || null), token), appAccess?.token ?? null),
      supabaseTokenClean,
    );
  /** The same secrets, as a list — the delta holdback (flushDeltas) needs to
   *  recognize a secret's PREFIX at a chunk boundary, which the whole-string
   *  redact above cannot do on a fragment. */
  const secretList = [ghToken, internalSecret || null, token, appAccess?.token ?? null, supabaseTokenClean]
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const flush = async () => {
    if (buffer.length === 0) return;
    let batch: unknown[] = buffer.map((e) => ({ ...e, run_id: runId }));
    buffer = [];
    // A run working in a cloned repo can print its tokenised remote URL (git does
    // this on a failed push), and these rows are the permanent transcript — so every
    // secret is scrubbed from text AND payload before anything is stored. Done on the
    // serialized batch because a token is alphanumeric and cannot survive JSON
    // escaping in a different form.
    try {
      batch = JSON.parse(redactSecrets(JSON.stringify(batch))) as unknown[];
    } catch {
      // Unserializable batch: fall through with the mapped rows rather than
      // dropping the events entirely.
    }
    const { error } = await db.from("claude_run_events").insert(batch);
    if (error) console.error("[claude/runner] event insert failed:", error.message);
  };

  interface Attempt {
    sessionId: string | null;
    lastResult: string | null;
    resultEvent: Record<string, unknown> | null;
    stderrTail: string;
    spawnError: string | null;
    exitCode: number | null;
    ok: boolean;
  }

  /**
   * Spawn the engine once and collect its stream to completion. Extracted so a
   * resume that finds no transcript can be retried as a fresh session without
   * duplicating the stream-parsing machinery.
   */
  const runEngine = async (resume: string | null, fork = false): Promise<Attempt> => {
    const args = buildArgs(resume, fork);
    let sessionId: string | null = null;
    let lastResult: string | null = null;
    // The whole `result` event, kept because its usage/cost/turn figures are what
    // the usage view is built from.
    let resultEvent: Record<string, unknown> | null = null;
    let stderrTail = "";
    // A spawn failure (most often the binary not being found on the host) produces
    // no stderr and a null exit code, so it has to be captured here or the run
    // would be recorded as an unexplained "exit code null".
    let spawnError: string | null = null;

    // Word-by-word deltas, held back just enough that a secret split across
    // two deltas can never leave the server: the cut point is walked back past
    // any suffix that matches a PREFIX of a known secret, and what is emitted
    // goes through redactSecrets like every stored row. Force-flushed at block
    // end and at process close (the tail is tiny either way).
    let deltaPending = "";
    const flushDeltas = (force: boolean): void => {
      if (!deltaPending) return;
      let cut = deltaPending.length;
      if (!force) {
        let moved = true;
        while (moved && cut > 0) {
          moved = false;
          for (const s of secretList) {
            const maxK = Math.min(s.length - 1, cut);
            for (let k = maxK; k > 0; k--) {
              if (deltaPending.startsWith(s.slice(0, k), cut - k)) {
                cut -= k;
                moved = true;
                break;
              }
            }
          }
        }
      }
      if (cut <= 0) return;
      const out = redactSecrets(deltaPending.slice(0, cut));
      deltaPending = deltaPending.slice(cut);
      if (out) {
        runEventBus.emit(`ev:${runId}`, {
          seq: 0,
          kind: "delta",
          text: out,
          tool_name: null,
          created_at: new Date().toISOString(),
        } satisfies LiveEvent);
      }
    };

    const child = spawn(bin, args, {
      cwd: cwd || run.cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    running.set(runId, child);

    const timer = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);

    // Liveness ping — bumps updated_at on a fixed cadence, independent of the event
    // stream, so a run doing a long silent tool call (a multi-minute build emits no
    // stream lines) still reads as alive. Gated on status='running' so a ping can
    // never touch a row the recoverer already claimed or failed. This is the single
    // signal both the UI live line and the recoverer trust to tell an active run
    // from an orphaned one.
    const heartbeat = setInterval(() => {
      void db
        .from("claude_runs")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("status", "running")
        .then(({ error }) => {
          if (error) console.error("[claude/runner] heartbeat failed:", error.message);
        });
    }, HEARTBEAT_MS);

    // SIGTERM first so the engine can close cleanly, then SIGKILL if it doesn't. With
    // only SIGTERM, a child that ignores it never emits 'close' — the await below
    // would never resolve, the run would sit in 'running' forever, and the cloned
    // workspace (which holds the GitHub token in .git/config) would stay on disk.
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
    }, timeoutMs);

    let stdoutRest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutRest += chunk;
      const lines = stdoutRest.split("\n");
      stdoutRest = lines.pop() ?? "";
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Not JSON — still worth keeping; the stream is the record.
          buffer.push({
            seq: nextSeq(),
            kind: "system",
            text: truncate(trimmed),
            tool_name: null,
            payload: null,
          });
          continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (!sessionId && typeof obj.session_id === "string") sessionId = obj.session_id;
        // Partial-message deltas (--include-partial-messages): live-stream them
        // and NOTHING else — a delta per token stored to claude_run_events
        // would flood the table (the completed block still arrives as a normal
        // assistant event below, and THAT is stored). kind:"delta", seq:0 —
        // the client renders them as the growing tail of the answer bubble and
        // never merges them into the stored-event list. Emission goes through
        // flushDeltas, which holds back any tail that could be the PREFIX of a
        // known secret split across deltas — the plain redact can only catch a
        // secret it sees whole.
        if (obj.type === "stream_event") {
          // A sub-agent's (Task tool) inner stream — not the main answer.
          if (obj.parent_tool_use_id) continue;
          const sev = obj.event as Record<string, unknown> | undefined;
          if (sev?.type === "content_block_delta") {
            const d = sev.delta as Record<string, unknown> | undefined;
            if (d?.type === "text_delta" && typeof d.text === "string" && d.text) {
              deltaPending += d.text;
              flushDeltas(false);
            }
          } else if (sev?.type === "content_block_stop") {
            flushDeltas(true);
          }
          continue;
        }
        if (obj.type === "result") {
          resultEvent = obj;
          if (typeof obj.result === "string") lastResult = obj.result;
        }
        const mapped = mapLine(parsed, nextSeq);
        // Live push to any open stream BEFORE the DB batch — this is the whole
        // point of the bus (sub-second output). Redacted per event, because the
        // batch-level redaction below only covers what goes to the DB.
        const emittedAt = new Date().toISOString();
        for (const ev of mapped) {
          runEventBus.emit(`ev:${runId}`, {
            seq: ev.seq,
            kind: ev.kind,
            text: ev.text === null ? null : redactSecrets(ev.text),
            tool_name: ev.tool_name,
            created_at: emittedAt,
          } satisfies LiveEvent);
        }
        buffer.push(...mapped);
        if (buffer.length >= FLUSH_EVERY) void flush();
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only the tail: stderr is diagnostics, and the run row is not a log sink.
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    await new Promise<void>((resolve) => {
      child.on("error", (err) => {
        spawnError = `could not start '${bin}': ${err.message}`;
        buffer.push({
          seq: nextSeq(),
          kind: "error",
          text: truncate(spawnError),
          tool_name: null,
          payload: null,
        });
        resolve();
      });
      child.on("close", () => resolve());
    });

    clearInterval(timer);
    clearInterval(heartbeat);
    clearTimeout(killTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    // Off the registry the moment the process is gone, so a later cancel reports
    // "nothing running" instead of signalling a recycled pid.
    running.delete(runId);
    // Whatever tail the holdback still held — the process is done, flush it.
    flushDeltas(true);
    if (stdoutRest.trim()) {
      buffer.push({
        seq: nextSeq(),
        kind: "system",
        text: truncate(stdoutRest.trim()),
        tool_name: null,
        payload: null,
      });
    }
    await flush();

    const exitCode = child.exitCode;
    return {
      sessionId,
      lastResult,
      resultEvent,
      stderrTail,
      spawnError,
      exitCode,
      ok: spawnError === null && exitCode === 0,
    };
  };

  // The first attempt resumes the thread's own session if it has one; otherwise, on
  // a method-A fork child's first turn, it resumes the PARENT's session and forks it.
  const initialResume = resumeSession ?? forkFromSession;
  const initialFork = !resumeSession && !!forkFromSession;
  let attempt = await runEngine(initialResume, initialFork);
  // What the turn ACTUALLY resumed into. Diverges from resumeSession only when the
  // fallback fires, and the thread/DB updates below key off this rather than the
  // original request.
  let effectiveResume = resumeSession;

  // The one resume failure we can recover from: the engine session the DB remembers
  // is simply gone — the container was recycled (Railway is ephemeral) or the
  // workspace was swept between turns, so `--resume <id>` finds no transcript and
  // the CLI aborts with "No conversation found with session ID: …". Left as-is this
  // dead-ends EVERY follow-up on the thread. So retry once as a fresh session: the
  // earlier context is already lost with the transcript, and continuing the chat
  // beats refusing it. resumed_session=null makes the screen's "context lost" banner
  // say exactly what happened. Guarded on `resumeSession` so a first turn (which
  // never resumes) can't loop, and matched narrowly so an ordinary failure — an
  // auth error, the user's own bug — is NOT silently re-run.
  const resumeMissing =
    !attempt.ok &&
    /no conversation found|no conversation with session|session id .*not found|could not (?:find|resume) session/i.test(
      `${attempt.lastResult ?? ""} ${attempt.stderrTail}`,
    );
  // Guarded on initialResume (not just resumeSession) so a fork child whose parent
  // session is gone also recovers as a fresh session instead of dead-ending.
  if (initialResume && resumeMissing) {
    console.warn(
      `[claude/runner] resume ${initialResume} not found for run ${runId} — retrying as a fresh session`,
    );
    effectiveResume = null;
    // Don't start blank. The engine session is gone, but the conversation isn't:
    // rebuild it from OUR DB (claude_runs) and prepend it, so the fresh session
    // continues WITH context instead of forgetting everything — the same stateless
    // re-feed claude.ai does, sourced from our durable rows rather than the wiped
    // on-disk transcript. Prepended to the in-memory promptText ONLY, deliberately
    // NOT written back to claude_runs: a later reconstruction must read the clean
    // user prompt so rebuilt history never nests inside itself and re-bloats.
    //
    // Re-composed through composePrompt on purpose: the rebuilt history is now the
    // CLEAN user/assistant exchange (transcript.ts reads user_prompt, not the
    // composed turn-1 prompt), so the environment preamble and standing
    // instructions no longer ride along inside it — they must be re-attached here
    // or the fresh session would wake with no orientation at all.
    if (run.thread_id) {
      const history = await buildThreadTranscript(run.thread_id, runId);
      if (history) {
        const seeded =
          `# רקע מהשיחה הקודמת (שוחזר מההיסטוריה)\n\n${history}\n\n---\n\n${promptText}`;
        const recomposed = await composePrompt(run.org_id, seeded, null);
        promptText = recomposed.prompt;
      }
    }
    attempt = await runEngine(null);
  }

  const { sessionId, lastResult, resultEvent, stderrTail, spawnError, exitCode, ok } = attempt;

  // A wrong paste in the token field surfaces as "401 Invalid bearer token" from
  // inside the stream, which reads like an outage rather than a misconfiguration.
  // Anthropic credentials are `sk-ant-…`, so when the configured value isn't, say
  // so alongside the failure instead of leaving the 401 to be interpreted.
  const failureText = `${lastResult ?? ""} ${stderrTail}`;
  const authLooksWrong =
    !ok && /401|invalid bearer|authenticat/i.test(failureText) && !token.startsWith("sk-ant-");
  const hint = authLooksWrong
    ? ` — hint: the configured ${tokenKey} does not start with 'sk-ant-', which is ` +
      "unusual for a Claude credential. Check that the saved value is the token " +
      "printed by `claude setup-token`."
    : "";

  // The subscription window ran out mid-turn. NOT a failure the user must resend:
  // park the row back in 'queued' with the machine-readable sentinel on `error`,
  // and the recoverer retries it every ~15 minutes until the window resets
  // (recover.ts) — the same "arm the resume, don't react" idea as the long-task
  // watchdog, applied to console turns. Guarded on status='running' so a cancel
  // that landed meanwhile is never resurrected; if the guarded write matched
  // nothing (or errored), fall through to the honest failed state instead.
  const usageLimited = !ok && spawnError === null && detectUsageLimit(failureText);
  if (usageLimited) {
    // When the message names the reset moment, carry it in the sentinel so the
    // retry happens right after the window opens instead of blind 15-min probes.
    const resetAt = parseUsageResetTime(failureText);
    const untilPart = resetAt ? `until=${resetAt.toISOString()}; ` : "";
    const { data: parked, error: wErr } = await db
      .from("claude_runs")
      .update({
        status: "queued",
        error: `${USAGE_LIMIT_SENTINEL}${untilPart} ${truncate(redactSecrets(failureText.trim()), 400)}`,
        started_at: null,
        ended_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();
    if (wErr) console.error("[claude/runner] usage-limit park failed:", wErr.message);
    if (parked) {
      // Record the exhaustion event append-only RIGHT NOW — this park is the only
      // moment the "100% used" ground truth exists. The recoverer will resume this
      // run and flip error back to 'done', erasing the usage-limit-wait sign, so a
      // field that flips cannot be the source (docs/claude-usage-calibration-process.md).
      // record_claude_usage_hit reconstructs the account's window and snapshots its
      // consumption from claude_runs; idempotent per (account, kind, window). The
      // CLI names which limit was hit ("weekly limit" vs "session limit").
      if (run.claude_account) {
        const usageKind = /weekly\s+limit/i.test(failureText) ? "weekly" : "session";
        const { error: hitErr } = await db.rpc("record_claude_usage_hit", {
          p_account: run.claude_account,
          p_kind: usageKind,
          p_reset_at: resetAt ? resetAt.toISOString() : null,
        });
        if (hitErr)
          console.error("[claude/runner] usage-hit record failed:", hitErr.message);
      }
      if (appAccess) void revokeAppAccess(appAccess.token);
      return;
    }
  }

  await finish({
    status: ok ? "done" : "failed",
    session_id: sessionId,
    // Corrected here rather than trusting the value written before the spawn: if the
    // fallback fired, this turn resumed nothing, and the row must say so.
    resumed_session: effectiveResume,
    result_summary: truncate(lastResult === null ? null : redactSecrets(lastResult)),
    // Recorded even for a failed run: a run that burned tokens before failing
    // still consumed them, and hiding that would understate real usage.
    ...usageFromResult(resultEvent),
    error: ok
      ? null
      : truncate(
          redactSecrets(
            `${spawnError || stderrTail || lastResult || `exit code ${String(exitCode)}`}${hint}`,
          ),
          4000,
        ),
  });

  // The minted session's run is over — revoke it rather than letting turns pile
  // up live sessions. Fire-and-forget: the thread update below must not wait on it.
  if (appAccess) void revokeAppAccess(appAccess.token);

  // Carry the engine session onto the THREAD. This is what the next turn resumes
  // into, so without it every message would start a fresh session and the chat
  // would have no memory. Written only when the thread has none yet: a resumed
  // turn reports the same id, and overwriting on every turn would let one failed
  // turn's null wipe a working session.
  if (run.thread_id) {
    const patch: Record<string, unknown> = {
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Written on EVERY turn, not only the first. `--resume` continues the
    // transcript under a NEW session id, so keeping the turn-1 id would make turn 3
    // resume a transcript that ends at turn 1 — turn 2 silently lost. Compared
    // against effectiveResume (what we actually resumed), so a fresh-session
    // fallback correctly stores its brand-new id and the thread heals itself for
    // the next turn. Guarded on a successful turn so a failure cannot replace a
    // working session with nothing.
    if (ok && sessionId && sessionId !== effectiveResume) patch.session_id = sessionId;
    const { error: tErr } = await db.from("claude_threads").update(patch).eq("id", run.thread_id);
    if (tErr) console.error("[claude/runner] thread update failed:", tErr.message);
  }

  // Completion push — closes the one availability gap vs Claude Code on the web:
  // a turn long enough that the user has walked away (>2 min), or any failure,
  // reaches their phone instead of waiting to be noticed on screen. The
  // `notifications` insert fans out to Web Push via the platform's AFTER INSERT
  // trigger (lib/platform/notify.ts). Skipped for the automation account —
  // background work must not ping the phone — and fire-and-forget: a
  // notification failure never touches the turn's outcome.
  const elapsedWallMs = Date.now() - startedWallMs;
  const isAutomation = (run.claude_account ?? "").trim().toLowerCase() === AUTOMATION_ACCOUNT;
  if (run.thread_id && run.created_by && !isAutomation && (!ok || elapsedWallMs >= NOTIFY_MIN_MS)) {
    void (async () => {
      try {
        const { data: tRow } = await db
          .from("claude_threads")
          .select("title")
          .eq("id", run.thread_id)
          .maybeSingle();
        const threadTitle = tRow?.title?.trim() || run.prompt.slice(0, 60);
        await notify(run.org_id, run.created_by, {
          app_slug: "smrttask",
          type: ok ? "success" : "warning",
          title: ok ? "הרצת קלוד הסתיימה" : "הרצת קלוד נכשלה",
          body: threadTitle,
          link: `/claude?thread=${run.thread_id}`,
          entity_type: "claude_thread",
          entity_id: run.thread_id,
        });
      } catch (e) {
        console.error("[claude/runner] completion notify failed:", e instanceof Error ? e.message : e);
      }
    })();
  }
}

/** A successful turn shorter than this sends no completion push — the user is
 *  almost certainly still looking at the screen. Failures always notify. */
const NOTIFY_MIN_MS = 2 * 60 * 1000;

/**
 * Background LLM calls route by task TYPE, never by guessing difficulty (the
 * "model proposes, code confirms" danger zone). Trivial/mechanical work — a thread
 * title, a board summary — runs on the fast model. Decision/analysis work —
 * split/group/decompose proposals — is PINNED to a strong model and is never
 * downgraded, because a weaker model there would silently degrade a judgment the
 * user can't easily see was wrong. Centralized here so each id has one place to
 * update and can't age silently in five call sites.
 */
export const BG_MODEL_FAST = "claude-haiku-4-5-20251001";
export const BG_MODEL_STRONG = "claude-opus-5";

/**
 * Run a short prompt on the subscription and return its text — no rows, no events.
 *
 * This is the mechanism behind the analysis runs (a thread's real title today;
 * split/group proposals next — docs/claude-console/threads-split-and-group-plan.md).
 * It deliberately does NOT create a claude_runs row: a title is not a turn of the
 * conversation, and putting it in the thread would show the user an exchange they
 * never had. It DOES write one best-effort `log_entries` provenance row per call
 * (category `claude_bg_model`, level `info`) recording which model and account ran
 * which task — required once background calls route to different models, so
 * model→quality stays auditable. `label` names the task in that row.
 *
 * Runs on a subscription token like every other run, so it costs subscription
 * usage and ZERO paid API tokens. Returns null on any failure — a missing title is
 * a cosmetic loss and must never break the turn that triggered it. Pass
 * `account: AUTOMATION_ACCOUNT` to route the call to the second subscription.
 */
export async function runOneShot(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; account?: string; label?: string } = {},
): Promise<string | null> {
  const { token } = await loadAccountToken(opts.account);
  if (!token) return null;

  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const args = ["-p", "--output-format", "text"];
  if (opts.model) args.push("--model", opts.model);
  // The prompt is a positional argument, passed LAST behind `--` so a "-"-leading
  // prompt isn't parsed as a CLI option (same fix as buildArgs above).
  args.push("--", prompt);

  const startedAt = Date.now();
  // One best-effort provenance row per background call: which model/account ran
  // which task, and whether it produced output. level 'info' on purpose — the
  // error-notification trigger fires only on 'error', and a background model choice
  // is not an error. Fire-and-forget so it never delays returning the result.
  const logProvenance = (ok: boolean, note?: { code?: number | null; stderr?: string }): void => {
    // Fire-and-forget in its own async IIFE with try/catch: the PostgREST builder is
    // a thenable without .catch, so a network-level reject would otherwise become an
    // unhandled rejection. Provenance is best-effort and never fails a run.
    void (async () => {
      try {
        // On FAILURE, carry WHY: the CLI's exit code and a redacted stderr tail. This
        // is the only place the one-shot's error surfaces — the CLI's stderr is
        // otherwise discarded, which is exactly what left a burst of ~2s title
        // failures undiagnosable (usage-limit? bad model? auth?). Success stays lean.
        const details: Record<string, unknown> = {
          task: opts.label ?? "unknown",
          model: opts.model ?? "cli-default",
          account: opts.account ?? "primary",
        };
        if (!ok) {
          if (note?.code !== undefined) details.exit_code = note.code;
          const errTail = (note?.stderr ?? "").trim();
          // Scrub the OAuth token (the only secret in this one-shot's env) before
          // storing; `redact` is a no-op if it never appears. Keep the last 400 chars
          // — the CLI prints its actionable error at the END of stderr.
          if (errTail) details.stderr = redact(errTail, token).slice(-400);
        }
        const { error } = await db.from("log_entries").insert({
          user_id: null,
          level: "info",
          category: "claude_bg_model",
          status: ok ? "ok" : "failed",
          processing_duration_ms: Date.now() - startedAt,
          details,
        });
        if (error) console.error("[claude/oneshot] provenance log failed:", error.message);
      } catch {
        // best-effort
      }
    })();
  };

  return new Promise((resolve) => {
    const child = spawn(resolveCli(), args, {
      // The OS temp dir, not the app directory: a one-shot has no business being
      // able to read or touch the deployed source tree.
      cwd: os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      if (out.length > 8000) out = out.slice(0, 8000);
    });
    // Capture stderr (previously piped but never read) so a failure records WHY.
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      err += c;
      if (err.length > 4000) err = err.slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 90_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      logProvenance(false, { code: null, stderr: `spawn error: ${e instanceof Error ? e.message : String(e)}` });
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = code === 0 && out.trim() ? out.trim() : null;
      // A non-zero exit with output on stdout is rare; prefer stderr, fall back to
      // the stdout tail so an error message printed to stdout isn't lost either.
      logProvenance(result !== null, { code, stderr: err || out });
      resolve(result);
    });
  });
}
