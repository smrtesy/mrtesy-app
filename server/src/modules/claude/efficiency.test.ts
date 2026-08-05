/**
 * Regression checks for the Level-1 waste detector (efficiency.ts).
 *
 * No test runner is wired in this repo, so run directly:
 *   npx tsx src/modules/claude/efficiency.test.ts   (from server/)
 * Exit 0 = all pass, exit 1 = a failure.
 *
 * Every case is a hand-built event stream that pins ONE behaviour, so the next
 * change to the detector either keeps these facts or is caught here. The flags
 * are deterministic facts about the stream, which is the whole point of the
 * detector — these tests encode what "waste" means so it can't quietly drift.
 */
import assert from "node:assert";
import { analyzeRun, normalizeDbEvent, type NormEvent } from "./efficiency";

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
};

let seq = 0;
const use = (toolName: string, input: Record<string, unknown> = {}): NormEvent => ({
  seq: seq++,
  kind: "tool_use",
  toolName,
  input,
});
const result = (isError = false): NormEvent => ({ seq: seq++, kind: "tool_result", isError });
const reset = () => {
  seq = 0;
};

// ---- duplicate_read ------------------------------------------------------
check("flags a re-read of the same file with nothing changed in between", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }),
    result(),
    use("Read", { file_path: "a.ts" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 1);
  assert.equal(r.flags[0].detail, "a.ts");
});

check("does NOT flag a re-read after an Edit to that file", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }),
    result(),
    use("Edit", { file_path: "a.ts" }),
    result(),
    use("Read", { file_path: "a.ts" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 0);
});

check("does NOT flag re-reads of the same file at different offsets", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts", offset: 0, limit: 100 }),
    result(),
    use("Read", { file_path: "a.ts", offset: 100, limit: 100 }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 0);
});

check("does NOT flag a re-read after a WRITING shell command", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }),
    result(),
    use("Bash", { command: "echo x > a.ts" }),
    result(),
    use("Read", { file_path: "a.ts" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 0);
});

// ---- redundant_search ----------------------------------------------------
check("flags an identical repeated Grep", () => {
  reset();
  const r = analyzeRun([
    use("Grep", { pattern: "foo", path: "src" }),
    result(),
    use("Grep", { pattern: "foo", path: "src" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "redundant_search").length, 1);
});

check("does NOT flag Greps with different patterns", () => {
  reset();
  const r = analyzeRun([
    use("Grep", { pattern: "foo" }),
    result(),
    use("Grep", { pattern: "bar" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "redundant_search").length, 0);
});

// ---- error_retry ---------------------------------------------------------
check("flags hammering a call that errored, counting the retries", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "node build.js" }),
    result(true),
    use("Bash", { command: "node build.js" }),
    result(true),
    use("Bash", { command: "node build.js" }),
    result(),
  ]);
  const retry = r.flags.filter((f) => f.code === "error_retry");
  assert.equal(retry.length, 1);
  assert.equal(retry[0].count, 2); // two retries after the first error
});

check("does NOT flag the build-fails → edit → build-passes loop (HIGH regression)", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "npm run build" }),
    result(true), // build fails
    use("Edit", { file_path: "a.ts" }), // fix the code
    result(),
    use("Bash", { command: "npm run build" }), // required re-run, NOT waste
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "error_retry").length, 0);
});

check("still flags hammering when there is NO edit between the retries", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "npm run build" }),
    result(true),
    use("Bash", { command: "npm run build" }),
    result(true),
  ]);
  const retry = r.flags.filter((f) => f.code === "error_retry");
  assert.equal(retry.length, 1);
  assert.equal(retry[0].count, 1);
});

check("does NOT flag duplicate_read when the first read ERRORED then retried", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "missing.ts" }),
    result(true), // read failed
    use("Read", { file_path: "missing.ts" }), // legitimate retry, not a duplicate
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 0);
});

check("does NOT flag a re-run of a call that SUCCEEDED", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "ls" }),
    result(),
    use("Bash", { command: "ls" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "error_retry").length, 0);
});

check("does NOT invent a retry from parallel tool calls (error mis-attribution)", () => {
  reset();
  // One turn issues two tool_use blocks, then two results — the ERROR result is
  // first, while the last outstanding call is the SUCCESSFUL one. A naive pairing
  // would pin the error on the successful call and flag its later repeat.
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }), // errors (its result comes first)
    use("Bash", { command: "ls" }), // succeeds
    result(true), // error result (for the Read)
    result(false), // ok result (for the Bash)
    use("Bash", { command: "ls" }), // a legit repeat of the successful call
    result(false),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "error_retry").length, 0);
});

// ---- unbatched_reads -----------------------------------------------------
check("flags 3+ consecutive read-only shell calls", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "grep -n foo a.ts" }),
    result(),
    use("Bash", { command: "ls src" }),
    result(),
    use("Bash", { command: "wc -l a.ts" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "unbatched_reads").length, 1);
  assert.equal(r.flags.find((f) => f.code === "unbatched_reads")!.count, 3);
});

check("does NOT flag 2 read-only shell calls (below the run threshold)", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "ls" }),
    result(),
    use("Bash", { command: "pwd" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "unbatched_reads").length, 0);
});

check("a writing git command is not counted as read-only shell", () => {
  reset();
  const r = analyzeRun([
    use("Bash", { command: "git status" }),
    result(),
    use("Bash", { command: "git commit -m x" }),
    result(),
    use("Bash", { command: "git log" }),
    result(),
  ]);
  assert.equal(r.flags.filter((f) => f.code === "unbatched_reads").length, 0);
});

// ---- counts + score ------------------------------------------------------
check("tallies tool counts and a positive waste score on a wasteful run", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }),
    result(),
    use("Read", { file_path: "a.ts" }),
    result(),
  ]);
  assert.equal(r.toolCalls, 2);
  assert.equal(r.toolCounts.Read, 2);
  assert.ok(r.wasteScore > 0);
});

check("a clean run has no flags and score 0", () => {
  reset();
  const r = analyzeRun([
    use("Read", { file_path: "a.ts" }),
    result(),
    use("Edit", { file_path: "a.ts" }),
    result(),
    use("Grep", { pattern: "foo" }),
    result(),
  ]);
  assert.equal(r.flags.length, 0);
  assert.equal(r.wasteScore, 0);
});

// ---- normalizeDbEvent (the DB adapter) -----------------------------------
check("normalizeDbEvent reads tool input from payload.input", () => {
  const ev = normalizeDbEvent({
    seq: 1,
    kind: "tool_use",
    tool_name: "Read",
    text: '{"file_path":"a.ts"}',
    payload: { name: "Read", input: { file_path: "a.ts" } },
  });
  assert.equal(ev.toolName, "Read");
  assert.deepEqual(ev.input, { file_path: "a.ts" });
});

check("normalizeDbEvent falls back to parsing text when payload has no input", () => {
  const ev = normalizeDbEvent({ seq: 1, kind: "tool_use", tool_name: "Grep", text: '{"pattern":"x"}' });
  assert.deepEqual(ev.input, { pattern: "x" });
});

check("normalizeDbEvent tolerates truncated (unparseable) text", () => {
  const ev = normalizeDbEvent({ seq: 1, kind: "tool_use", tool_name: "Read", text: '{"file_path":"a.ts"…[truncated]' });
  assert.equal(ev.input, null);
});

check("normalizeDbEvent reads is_error from a tool_result payload", () => {
  const ok = normalizeDbEvent({ seq: 1, kind: "tool_result", payload: { is_error: false } });
  const bad = normalizeDbEvent({ seq: 2, kind: "tool_result", payload: { is_error: true } });
  assert.equal(ok.isError, false);
  assert.equal(bad.isError, true);
});

// End-to-end through the adapter: a duplicate read expressed as DB rows.
check("adapter + detector: duplicate read from DB-shaped rows", () => {
  const rows = [
    { seq: 0, kind: "tool_use", tool_name: "Read", text: null, payload: { input: { file_path: "a.ts" } } },
    { seq: 1, kind: "tool_result", payload: { is_error: false } },
    { seq: 2, kind: "tool_use", tool_name: "Read", text: null, payload: { input: { file_path: "a.ts" } } },
    { seq: 3, kind: "tool_result", payload: { is_error: false } },
  ];
  const r = analyzeRun(rows.map(normalizeDbEvent));
  assert.equal(r.flags.filter((f) => f.code === "duplicate_read").length, 1);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall efficiency tests passed");
