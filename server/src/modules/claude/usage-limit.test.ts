/**
 * Regression checks for usage-limit detection + reset-time parsing.
 *
 * No test runner is wired in this repo, so run directly:
 *   npx tsx src/modules/claude/usage-limit.test.ts   (from server/)
 * Exit 0 = all pass, exit 1 = a failure (with a diff line).
 *
 * WHY THIS FILE EXISTS: the CLI changed its limit wording from
 * "usage limit reached / limit will reset" to "You've hit your weekly|session
 * limit · resets …". The old regex matched neither, so every usage-limited run
 * landed as `failed` and the recoverer never resumed it (0 parked, 9 failed rows
 * carrying the message). These cases pin BOTH real 2026-08 phrasings so the next
 * wording drift is caught here, not six weeks later in the DB.
 */
import assert from "node:assert";
import { detectUsageLimit, parseUsageResetTime } from "./runner";

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

// A fixed "now" so the wall-clock scans are deterministic: 2026-08-04 12:00 UTC.
const NOW = Date.parse("2026-08-04T12:00:00Z");

// ---- detection ----------------------------------------------------------
const REAL_LIMIT_MESSAGES = [
  "You've hit your weekly limit · resets Aug 5, 10am (UTC)",
  "You've hit your session limit · resets 5am (UTC)",
  "Claude AI usage limit reached",
  "usage limit reached|1785600000",
  "Your limit will reset at 2026-08-05T05:00:00Z",
];
for (const m of REAL_LIMIT_MESSAGES) {
  check(`detect: "${m.slice(0, 42)}"`, () => assert.equal(detectUsageLimit(m), true));
}

// Must NOT match ordinary rate-limit noise from tools (would replay for a day).
const NON_LIMIT_MESSAGES = [
  "GitHub API rate limit exceeded for user",
  "429 Too Many Requests from some upstream",
  "You've exceeded your rate limit for this API",
  "error: unknown option '--foo'",
  // "daily"/"N-hour" are deliberately NOT our CLI's wording — a failed run merely
  // quoting a third-party quota line must not be parked and blind-probed for hours.
  "A downstream API said: you have reached your daily limit of 5000 requests",
  "provider error: exceeded your 24-hour limit",
];
for (const m of NON_LIMIT_MESSAGES) {
  check(`ignore: "${m.slice(0, 42)}"`, () => assert.equal(detectUsageLimit(m), false));
}

// ---- reset-time parsing -------------------------------------------------
check('parse "resets 5am (UTC)" → next 05:00 UTC', () => {
  const d = parseUsageResetTime("You've hit your session limit · resets 5am (UTC)", NOW);
  assert.ok(d, "expected a Date, got null");
  // now is Aug 4 12:00 UTC → next 5am UTC is Aug 5 05:00 UTC.
  assert.equal(d!.toISOString(), "2026-08-05T05:00:00.000Z");
});

check('parse "resets Aug 5, 10am (UTC)" → Aug 5 10:00 UTC', () => {
  const d = parseUsageResetTime("You've hit your weekly limit · resets Aug 5, 10am (UTC)", NOW);
  assert.ok(d, "expected a Date, got null");
  assert.equal(d!.toISOString(), "2026-08-05T10:00:00.000Z");
});

check('parse "resets at 3am (America/New_York)" (old form still works)', () => {
  const d = parseUsageResetTime("…limit will reset at 3am (America/New_York)", NOW);
  assert.ok(d, "expected a Date, got null");
  // Aug → EDT (UTC-4): 3am NY = 07:00 UTC, next occurrence Aug 5.
  assert.equal(d!.toISOString(), "2026-08-05T07:00:00.000Z");
});

check("parse epoch after pipe (machine form)", () => {
  const epochS = Math.floor(Date.parse("2026-08-05T05:00:00Z") / 1000);
  const d = parseUsageResetTime(`usage limit reached|${epochS}`, NOW);
  assert.ok(d, "expected a Date, got null");
  assert.equal(d!.toISOString(), "2026-08-05T05:00:00.000Z");
});

check("parse: unparseable message → null (recoverer falls back to blind probe)", () => {
  assert.equal(parseUsageResetTime("You've hit your weekly limit, try later", NOW), null);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall usage-limit checks passed");
