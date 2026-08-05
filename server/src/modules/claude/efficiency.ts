/**
 * Efficiency analysis of a Claude run's event stream — the "is it wasting tools
 * or turns" check surfaced at GET /api/claude/efficiency and on the console's
 * efficiency panel.
 *
 * PURE and source-agnostic on purpose. `analyzeRun` takes an ordered list of
 * `NormEvent` and returns deterministic waste flags + tool counts; it knows
 * nothing about the DB. The in-app console feeds it claude_run_events rows via
 * `normalizeDbEvent` (below); the identical detector can score any Claude
 * transcript once its events are normalized to `NormEvent` — which is why the
 * detector lives apart from the route and why the DB adapter is a thin,
 * separately-testable function.
 *
 * SCOPE IS LEVEL-1 ONLY: mechanical waste that is a *fact* in the event log —
 * a file re-read with nothing changed in between, an identical repeated search,
 * hammering a call that just errored, and read-only shell issued one-at-a-time
 * that could have been one command. It deliberately does NOT judge whether an
 * approach was "smart" or a tool call was "necessary": that needs a model, and a
 * model cannot be the authority on it (CLAUDE.md — "a model may propose; only
 * code may confirm a checkable fact"). Every flag here cites the exact `seq` it
 * was found at, so it is checkable by whoever reads it.
 */

export interface NormEvent {
  seq: number;
  /** 'tool_use' | 'tool_result' | 'assistant' | 'user' | 'system' | 'result' | 'error' */
  kind: string;
  /** Set on tool_use. */
  toolName?: string | null;
  /** Parsed tool input, set on tool_use. */
  input?: Record<string, unknown> | null;
  /** Set on tool_result: did the tool call error? */
  isError?: boolean;
}

export type FlagCode =
  | "duplicate_read"
  | "redundant_search"
  | "error_retry"
  | "unbatched_reads";

export interface EfficiencyFlag {
  code: FlagCode;
  severity: "low" | "med";
  /** Where the wasteful call is, so a reader can jump to it in the event stream. */
  seq: number;
  /** Human-readable specifics — the file path, the search pattern, the tool name. */
  detail: string;
  /** How many times (retries, or shell calls in the un-batched run). */
  count?: number;
}

export interface RunEfficiency {
  toolCalls: number;
  /** toolName → number of calls. */
  toolCounts: Record<string, number>;
  flags: EfficiencyFlag[];
  /** Weighted flag total, for ranking runs worst-first. Not a token count. */
  wasteScore: number;
}

/** Order-independent key for an input object, so a retry with the same args in a
 *  different key order still matches the original call. */
function stableInput(input: Record<string, unknown> | null | undefined): string {
  if (!input || typeof input !== "object") return "";
  try {
    return JSON.stringify(
      Object.keys(input)
        .sort()
        .map((k) => [k, input[k]]),
    );
  } catch {
    return "";
  }
}

const READONLY_GIT = /^git\s+(status|log|diff|show|branch|ls-files|rev-parse|remote|config\s+--get|--version|for-each-ref|cat-file|blame|describe|tag\s*$|shortlog)/;
const READONLY_CMDS = new Set([
  "grep", "rg", "ls", "cat", "head", "tail", "wc", "find", "stat", "echo",
  "pwd", "sed", "awk", "jq", "cut", "sort", "uniq", "diff", "tree", "which",
  "file", "basename", "dirname", "realpath", "test", "true",
]);
// Any of these appearing anywhere means the command can WRITE — never treat it as
// read-only, even if it starts with an allow-listed word (`cat x > y`, `sed -i`).
const WRITE_MARKERS = /(>|>>|\brm\b|\bmv\b|\bcp\b|\btee\b|\bdd\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bln\b|-i\b|--write|\binstall\b|\bapply\b|\bpush\b|\bcommit\b|\badd\b)/;

/**
 * Conservative: a shell command counts as read-only only if it has no write
 * marker AND every segment (split on && ; |) starts with an allow-listed
 * read-only command. Anything uncertain returns false, so this flag can only
 * ever UNDER-count — it never falsely accuses a writing command of being a
 * batchable read.
 */
function isReadOnlyShell(cmd: string): boolean {
  const c = (cmd || "").trim();
  if (!c || WRITE_MARKERS.test(c)) return false;
  const segments = c.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    if (READONLY_GIT.test(seg)) return true;
    const first = seg.split(/\s+/)[0];
    return READONLY_CMDS.has(first);
  });
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** How much each flag adds to the run's ranking score (med waste = 2, low = 1;
 *  a retried call counts once per retry). */
function flagWeight(f: EfficiencyFlag): number {
  const base = f.severity === "med" ? 2 : 1;
  if (f.code === "error_retry") return 2 * Math.max(1, f.count ?? 1);
  return base;
}

/**
 * Analyze one run's ordered events. The events MUST be in `seq` order; the caller
 * sorts. Returns tool counts and Level-1 waste flags.
 */
export function analyzeRun(events: NormEvent[]): RunEfficiency {
  const toolCounts: Record<string, number> = {};
  const flags: EfficiencyFlag[] = [];

  // Read/search dedup state. A file re-read is only waste if nothing could have
  // changed the file in between: an Edit/Write to THAT file clears it, and any
  // writing shell command clears everything (it could touch anything on disk).
  const seenReads = new Map<string, number>(); // `${path}|${offset}|${limit}` → seq
  const seenSearches = new Map<string, number>();

  // Retry state. A tool_use whose immediately-following tool_result errored is
  // recorded; a later identical tool_use is counted as a retry of it. Attribution
  // is done ONLY for cleanly-sequential calls: when a turn issues several tool_use
  // blocks in parallel (all the uses, then all the results), a result cannot be
  // matched to a specific call by position, so `usesSinceResult` guards against
  // pinning an error on the wrong call — the batch is simply skipped for retry
  // purposes. This can only UNDER-count retries, never invent one.
  const errored = new Map<string, { count: number; seq: number; toolName: string }>();
  let pending: { key: string; toolName: string; seq: number } | null = null;
  let usesSinceResult = 0;
  // The dedup entry (read/search) the CURRENT tool_use just added, so that if its
  // result errors we can roll it back — a re-read/re-search after a failed one is
  // a legitimate retry, not a duplicate.
  let pendingDedup: { map: Map<string, number>; key: string } | null = null;

  // Un-batched read-only shell: a run of ≥3 consecutive read-only Bash calls.
  let bashRun = 0;
  let bashRunStartSeq = 0;
  const flushBashRun = () => {
    if (bashRun >= 3) {
      flags.push({
        code: "unbatched_reads",
        severity: "low",
        seq: bashRunStartSeq,
        detail: `${bashRun} read-only shell calls in a row`,
        count: bashRun,
      });
    }
    bashRun = 0;
  };

  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  for (const ev of ordered) {
    if (ev.kind === "tool_result") {
      // Attribute only when exactly one tool_use is outstanding (sequential call).
      if (ev.isError && usesSinceResult === 1) {
        if (pending && !errored.has(pending.key)) {
          errored.set(pending.key, { count: 0, seq: pending.seq, toolName: pending.toolName });
        }
        // A read/search that ERRORED shouldn't count against a later retry of it.
        if (pendingDedup) pendingDedup.map.delete(pendingDedup.key);
      }
      usesSinceResult = 0;
      pending = null; // the result consumes the pending tool_use
      pendingDedup = null;
      continue;
    }

    if (ev.kind !== "tool_use") continue;

    usesSinceResult += 1;
    const name = ev.toolName || "unknown";
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    const input = ev.input ?? {};
    const key = `${name}|${stableInput(input)}`;

    // Retry: this call repeats one that previously errored.
    const priorError = errored.get(key);
    if (priorError) priorError.count += 1;
    pending = { key, toolName: name, seq: ev.seq };
    pendingDedup = null;

    if (name === "Bash") {
      const cmd = str((input as Record<string, unknown>).command);
      if (isReadOnlyShell(cmd)) {
        if (bashRun === 0) bashRunStartSeq = ev.seq;
        bashRun += 1;
      } else {
        // A writing shell command breaks the batch run AND invalidates dedup —
        // it could have changed any file we've read or searched.
        flushBashRun();
        seenReads.clear();
        seenSearches.clear();
      }
      continue;
    }

    // Any non-Bash tool ends a run of read-only shell calls.
    flushBashRun();

    if (name === "Read") {
      const fp = str((input as Record<string, unknown>).file_path);
      if (fp) {
        const rk = `${fp}|${str((input as Record<string, unknown>).offset)}|${str((input as Record<string, unknown>).limit)}`;
        if (seenReads.has(rk)) {
          flags.push({ code: "duplicate_read", severity: "low", seq: ev.seq, detail: fp });
        } else {
          seenReads.set(rk, ev.seq);
          pendingDedup = { map: seenReads, key: rk };
        }
      }
    } else if (name === "Grep") {
      const i = input as Record<string, unknown>;
      const sk = `grep|${str(i.pattern)}|${str(i.path)}|${str(i.glob)}|${str(i.output_mode)}`;
      if (seenSearches.has(sk)) {
        flags.push({ code: "redundant_search", severity: "low", seq: ev.seq, detail: str(i.pattern) });
      } else {
        seenSearches.set(sk, ev.seq);
        pendingDedup = { map: seenSearches, key: sk };
      }
    } else if (name === "Glob") {
      const i = input as Record<string, unknown>;
      const sk = `glob|${str(i.pattern)}|${str(i.path)}`;
      if (seenSearches.has(sk)) {
        flags.push({ code: "redundant_search", severity: "low", seq: ev.seq, detail: str(i.pattern) });
      } else {
        seenSearches.set(sk, ev.seq);
        pendingDedup = { map: seenSearches, key: sk };
      }
    } else if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
      // A write invalidates prior state for the touched file: a later re-read is
      // legitimate, and re-running a call that errored BEFORE the fix is required
      // work, not a retry (the "build fails → edit → build passes" loop). Clear
      // both. If the file path is unknown (a >100K-char input the runner
      // truncated in `payload`), clear ALL read dedup — the safe direction is to
      // under-count duplicates, never to invent one.
      errored.clear();
      const fp = str((input as Record<string, unknown>).file_path);
      if (fp) {
        for (const k of [...seenReads.keys()]) {
          if (k.startsWith(`${fp}|`)) seenReads.delete(k);
        }
      } else {
        seenReads.clear();
      }
    }
  }

  flushBashRun();

  // Emit a retry flag for every call that errored AND was retried at least once.
  for (const [, e] of errored) {
    if (e.count > 0) {
      flags.push({
        code: "error_retry",
        severity: "med",
        seq: e.seq,
        detail: e.toolName,
        count: e.count,
      });
    }
  }

  flags.sort((a, b) => a.seq - b.seq);
  const toolCalls = Object.values(toolCounts).reduce((s, n) => s + n, 0);
  const wasteScore = flags.reduce((s, f) => s + flagWeight(f), 0);
  return { toolCalls, toolCounts, flags, wasteScore };
}

/**
 * Adapter: one claude_run_events row → a NormEvent. Kept separate from the
 * detector so a different source (a session transcript JSONL) can supply its own
 * adapter without touching `analyzeRun`.
 *
 * Tool input is read from `payload.input` (the full, untruncated object the
 * runner stored) and falls back to parsing `text` (which is
 * `JSON.stringify(input)`, truncated at 20K — a truncated string fails JSON.parse
 * and yields null, which the detector treats as an empty input rather than
 * crashing). Error results are read from `payload.is_error`, the Anthropic
 * tool_result field the runner passes through verbatim in `safePayload`.
 */
export function normalizeDbEvent(row: {
  seq: number;
  kind: string;
  tool_name?: string | null;
  text?: string | null;
  payload?: unknown;
}): NormEvent {
  if (row.kind === "tool_use") {
    return { seq: row.seq, kind: row.kind, toolName: row.tool_name ?? null, input: extractInput(row) };
  }
  if (row.kind === "tool_result") {
    const p = row.payload as Record<string, unknown> | null | undefined;
    return { seq: row.seq, kind: row.kind, isError: !!(p && p.is_error === true) };
  }
  return { seq: row.seq, kind: row.kind };
}

function extractInput(row: { text?: string | null; payload?: unknown }): Record<string, unknown> | null {
  const p = row.payload as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object" && p.input && typeof p.input === "object") {
    return p.input as Record<string, unknown>;
  }
  if (typeof row.text === "string") {
    try {
      const parsed = JSON.parse(row.text);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* truncated or non-JSON text → treat as no input */
    }
  }
  return null;
}
