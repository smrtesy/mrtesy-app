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
 * API. The child environment is built from an allowlist (see ENV_ALLOWLIST), so
 * that key is excluded by construction rather than deleted afterwards, and
 * CLAUDE_CODE_OAUTH_TOKEN is required — a missing token fails loudly instead of
 * falling back to a billed path.
 *
 * CONTAINMENT — the agent gets no secret it has no reason to hold. This file
 * previously spread process.env into the child, which handed the agent every
 * credential the backend holds (service-role key, hosting tokens, provider keys).
 * A prompt-injected agent could exfiltrate those, and on Linux it needs no shell
 * to do it: the whole environment is readable as a file at /proc/self/environ, so
 * read-only tool access is sufficient. Four boundaries now apply:
 *
 *   1. ENV_ALLOWLIST      — the child sees only what it needs to run.
 *   2. EXTRA_ARG_ALLOWLIST — an env var cannot smuggle in a permission flag.
 *   3. allowed cwd roots   — cwd picks which CLAUDE.md/settings.json apply, and
 *                            therefore which permissions are inherited.
 *   4. redact()            — captured events are scrubbed before they are stored.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { db, getAppSecret } from "../../db";

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
 * The only environment variables the child process may see.
 *
 * An allowlist, not a denylist: the backend's environment holds the service-role
 * key, hosting tokens and provider keys, and enumerating what to remove means
 * every future variable is exposed by default. This list is what a run genuinely
 * needs, and nothing else reaches the agent.
 *
 * The network entries are not optional. Railway routes outbound traffic through a
 * proxy and can pin a CA bundle; dropping those variables makes a run fail on a
 * confusing network error rather than on anything to do with the prompt.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CLI_PATH",
] as const;

/**
 * Flags an operator may add through CLAUDE_RUN_EXTRA_ARGS.
 *
 * That variable is split and spliced into argv, so without an allowlist a single
 * environment variable could add --dangerously-skip-permissions and nothing in the
 * product would reveal that permissions had been turned off. Anything not listed
 * here is dropped and logged.
 */
const EXTRA_ARG_ALLOWLIST = new Set([
  "--max-turns",
  "--add-dir",
  "--fallback-model",
  "--append-system-prompt",
]);

/**
 * Tools a run may use, stated explicitly rather than inherited.
 *
 * The default is read-only. Widening it is a deliberate act with a visible
 * configuration change, which is the point: relying on Claude Code's default
 * refusal of write tools in -p mode would mean depending on behaviour we never
 * chose and do not test.
 */
const DEFAULT_ALLOWED_TOOLS = "Read Glob Grep";

/** Hard ceiling on a single run, so a hung process can't occupy the host forever. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Events are flushed in batches — a write per event would serialize the stream. */
const FLUSH_EVERY = 25;
const FLUSH_INTERVAL_MS = 1000;
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
 * Credential shapes scrubbed from anything we store.
 *
 * Captured events are both persisted and rendered in the console, so a secret the
 * agent read once would otherwise live in our database and on screen. Matching by
 * shape rather than by known value is what catches a credential we were never
 * given — one read out of a repo file or a query result.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-[redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-github-token]"],
  [/AIza[A-Za-z0-9_-]{20,}/g, "[redacted-google-key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"],
  // Supabase/PostgREST style connection strings carry the password inline.
  [/postgres(?:ql)?:\/\/[^\s"']*/g, "[redacted-postgres-url]"],
];

/** Scrub credential shapes out of a captured string. */
export function redact(s: string): string {
  let out = s;
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

function truncate(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const scrubbed = redact(v);
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}\n…[truncated]` : scrubbed;
}

/**
 * Resolve the directory a run executes in.
 *
 * cwd is a privilege decision, not just a location: it selects which CLAUDE.md and
 * .claude/settings.json apply, and therefore which permissions the agent inherits.
 * Accepting it unchecked from the caller would delegate that decision to whoever
 * posts the run. Allowed roots come from CLAUDE_RUN_ALLOWED_ROOTS; with none set,
 * naming a directory is rejected outright rather than quietly ignored, because a
 * run that silently executed somewhere else would be worse than one that failed.
 */
export function resolveCwd(requested: string | null): { cwd: string } | { error: string } {
  if (!requested) return { cwd: process.cwd() };

  const roots = (process.env.CLAUDE_RUN_ALLOWED_ROOTS || "")
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));

  if (roots.length === 0) {
    return {
      error:
        "This run names a working directory, but no allowed roots are configured. " +
        "Set CLAUDE_RUN_ALLOWED_ROOTS on the backend to the directories a run may " +
        "execute in.",
    };
  }

  // Resolve first so that ".." cannot climb out of an allowed root, and compare
  // against root + separator so "/srv/app-secrets" is not matched by "/srv/app".
  const target = path.resolve(requested);
  const permitted = roots.some((r) => target === r || target.startsWith(r + path.sep));
  if (!permitted) return { error: `working directory is not an allowed root: ${requested}` };
  return { cwd: target };
}

/** Keep only allowlisted flags from CLAUDE_RUN_EXTRA_ARGS, with their values. */
export function safeExtraArgs(raw: string): string[] {
  const parts = raw.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const flag = part.split("=")[0];
    const nextIsValue = () => parts[i + 1] !== undefined && !parts[i + 1].startsWith("--");

    if (!part.startsWith("--") || !EXTRA_ARG_ALLOWLIST.has(flag)) {
      console.warn(`[claude/runner] ignoring extra arg not on the allowlist: ${flag}`);
      // Drop the rejected flag's value too, so it can't be read as a bare argument.
      if (part.startsWith("--") && !part.includes("=") && nextIsValue()) i++;
      continue;
    }
    out.push(part);
    if (!part.includes("=") && nextIsValue()) out.push(parts[++i]);
  }
  return out;
}

/**
 * Keep `payload` useful without letting one giant tool result bloat the table —
 * and scrub it, since a credential can sit at any depth of a tool result. Redacting
 * the serialized form and reparsing catches nested values that walking known keys
 * would miss.
 */
function safePayload(raw: unknown): unknown {
  try {
    const s = redact(JSON.stringify(raw));
    if (s.length > MAX_PAYLOAD_CHARS) {
      return { truncated: true, size: s.length, head: s.slice(0, 2000) };
    }
    return JSON.parse(s);
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
 */
export async function executeRun(runId: string): Promise<void> {
  const { data: run, error: loadError } = await db
    .from("claude_runs")
    .select("id, prompt, cwd, status, model, effort")
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
  // stray newline or space rides along easily and would be sent verbatim.
  const token = (await getAppSecret(TOKEN_APP_SLUG, TOKEN_KEY, TOKEN_KEY))?.trim() || null;
  if (!token) {
    // Fail loudly rather than let Claude Code fall through to a billed credential.
    await finish({
      status: "failed",
      error:
        `${TOKEN_KEY} is not configured. Generate one with ` +
        "`npx @anthropic-ai/claude-code setup-token` (it authenticates with the Claude " +
        `subscription), then save it under /admin/apps/${TOKEN_APP_SLUG}/secrets — or ` +
        "set an environment variable of the same name on the backend.",
    });
    return;
  }

  const { error: startError } = await db
    .from("claude_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (startError) {
    console.error("[claude/runner] could not mark running:", startError.message);
    return;
  }

  // A privilege decision, so it is validated before anything is spawned.
  const cwdResult = resolveCwd(run.cwd ?? null);
  if ("error" in cwdResult) {
    await finish({ status: "failed", error: cwdResult.error });
    return;
  }

  // Built from the allowlist, so ANTHROPIC_API_KEY and every other backend
  // credential are absent by construction rather than removed afterwards.
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: token };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  const bin = resolveCli();
  const args = [
    "-p",
    run.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    process.env.CLAUDE_RUN_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS,
  ];
  // Omitted when unset rather than defaulted, so a run without a choice follows
  // the CLI's current default instead of being pinned to a model that will age.
  if (run.model) args.push("--model", run.model);
  if (run.effort) args.push("--effort", run.effort);
  args.push(...safeExtraArgs(process.env.CLAUDE_RUN_EXTRA_ARGS || ""));
  const timeoutMs = Number(process.env.CLAUDE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  let seq = 0;
  const nextSeq = () => ++seq;
  let buffer: PendingEvent[] = [];
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

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer.map((e) => ({ ...e, run_id: runId }));
    buffer = [];
    const { error } = await db.from("claude_run_events").insert(batch);
    if (error) console.error("[claude/runner] event insert failed:", error.message);
  };

  const child = spawn(bin, args, {
    // The validated root, never the raw request — see resolveCwd.
    cwd: cwdResult.cwd,
    env,
    // No shell: the prompt stays a separate argv entry, so it cannot be interpreted
    // as shell syntax however it is written.
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  const killTimer = setTimeout(() => {
    child.kill("SIGTERM");
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
      if (obj.type === "result") {
        resultEvent = obj;
        if (typeof obj.result === "string") lastResult = obj.result;
      }
      buffer.push(...mapLine(parsed, nextSeq));
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
  clearTimeout(killTimer);
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
  const ok = spawnError === null && exitCode === 0;

  // A wrong paste in the token field surfaces as "401 Invalid bearer token" from
  // inside the stream, which reads like an outage rather than a misconfiguration.
  // Anthropic credentials are `sk-ant-…`, so when the configured value isn't, say
  // so alongside the failure instead of leaving the 401 to be interpreted.
  const failureText = `${lastResult ?? ""} ${stderrTail}`;
  const authLooksWrong =
    !ok && /401|invalid bearer|authenticat/i.test(failureText) && !token.startsWith("sk-ant-");
  const hint = authLooksWrong
    ? ` — hint: the configured ${TOKEN_KEY} does not start with 'sk-ant-', which is ` +
      "unusual for a Claude credential. Check that the saved value is the token " +
      "printed by `claude setup-token`."
    : "";

  await finish({
    status: ok ? "done" : "failed",
    session_id: sessionId,
    result_summary: truncate(lastResult),
    // Recorded even for a failed run: a run that burned tokens before failing
    // still consumed them, and hiding that would understate real usage.
    ...usageFromResult(resultEvent),
    error: ok
      ? null
      : truncate(
          `${spawnError || stderrTail || lastResult || `exit code ${String(exitCode)}`}${hint}`,
          4000,
        ),
  });
}
