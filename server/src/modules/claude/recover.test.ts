/**
 * Regression checks for the orphan-resume give-up/counting decision.
 *
 * No test runner is wired in this repo, so run directly:
 *   npx tsx src/modules/claude/recover.test.ts   (from server/)
 * Exit 0 = all pass, exit 1 = a failure.
 *
 * WHY: a console turn that spans a couple of Railway restarts used to burn its
 * whole resume budget (MAX_RESUME_ATTEMPTS was 2) and give up though it never
 * actually failed — the observed "ניסינו להמשיך אותה אוטומטית ולא הצלחנו" message
 * across simultaneously-dying threads. classifyOrphanResume now distinguishes a
 * RESTART-orphan (external, doesn't count) from a self-inflicted crash (counts),
 * and these cases pin that split.
 */
import assert from "node:assert";
import { classifyOrphanResume } from "./recover";

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

const BOOT = Date.parse("2026-08-04T12:00:00Z"); // this process started here
const NOW = BOOT + 5 * 60 * 1000; // 5 min into the process
const HOUR = 3600_000;
const before = (ms: number) => BOOT - ms; // a heartbeat/creation before boot
const after = (ms: number) => BOOT + ms; // …after boot

// A run alive before this process started = killed by the restart that birthed it.
check("restart-orphan: does NOT count, even over the cap", () => {
  const d = classifyOrphanResume({
    attempts: 9,
    lastBeatMs: before(2 * 60_000), // last heartbeat 2 min before boot
    createdMs: before(10 * 60_000),
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.restartOrphan, true);
  assert.equal(d.giveUp, false, "an external restart must not doom the run");
  assert.equal(d.nextAttempts, 9, "restart-orphan keeps the counter");
});

// A run whose heartbeat is DURING this process = it crashed on its own.
check("self-crash under cap: counts, resumes", () => {
  const d = classifyOrphanResume({
    attempts: 1,
    lastBeatMs: after(2 * 60_000),
    createdMs: after(60_000),
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.restartOrphan, false);
  assert.equal(d.giveUp, false);
  assert.equal(d.nextAttempts, 2);
});

check("self-crash at cap (3): gives up", () => {
  const d = classifyOrphanResume({
    attempts: 3,
    lastBeatMs: after(2 * 60_000),
    createdMs: after(60_000),
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.giveUp, true);
});

check("self-crash one under cap (2): last resume, then would cap", () => {
  const d = classifyOrphanResume({
    attempts: 2,
    lastBeatMs: after(2 * 60_000),
    createdMs: after(60_000),
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.giveUp, false);
  assert.equal(d.nextAttempts, 3);
});

// The absolute bound terminates even a never-counted restart-orphan.
check("too old: gives up even as a restart-orphan", () => {
  const d = classifyOrphanResume({
    attempts: 0,
    lastBeatMs: before(60_000),
    createdMs: NOW - 25 * HOUR, // created 25h ago (> ORPHAN_MAX_AGE_MS 24h)
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.restartOrphan, true);
  assert.equal(d.giveUp, true, "past the absolute age bound, terminate regardless");
});

// Fail closed: an unknown creation time must not DISABLE the age bound (which would
// let a perpetual restart-orphan spin forever) — it counts as past the bound.
check("unparseable created_at (0): gives up (fail closed)", () => {
  const d = classifyOrphanResume({
    attempts: 0,
    lastBeatMs: before(60_000), // a restart-orphan…
    createdMs: 0, // …with an unknown creation time
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.giveUp, true, "unknown age must terminate, not exempt");
});

// A 0 (unparseable) heartbeat is "unknown", not "1970" — must NOT read as a
// restart-orphan (which would let it dodge the counter forever).
check("unparseable heartbeat (0): treated as self-crash, counts", () => {
  const d = classifyOrphanResume({
    attempts: 1,
    lastBeatMs: 0,
    createdMs: after(60_000),
    nowMs: NOW,
    bootMs: BOOT,
  });
  assert.equal(d.restartOrphan, false);
  assert.equal(d.nextAttempts, 2);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall recover checks passed");
