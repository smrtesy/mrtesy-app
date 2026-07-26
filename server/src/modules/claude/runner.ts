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

  // Subscription auth must win — see the billing note in this file's header.
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const bin = resolveCli();
  const extra = (process.env.CLAUDE_RUN_EXTRA_ARGS || "").split(" ").filter(Boolean);
  const args = ["-p", run.prompt, "--output-format", "stream-json", "--verbose"];
  // Omitted when unset rather than defaulted, so a run without a choice follows
  // the CLI's current default instead of being pinned to a model that will age.
  if (run.model) args.push("--model", run.model);
  if (run.effort) args.push("--effort", run.effort);
  args.push(...extra);
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
    cwd: run.cwd || process.cwd(),
    env,
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
