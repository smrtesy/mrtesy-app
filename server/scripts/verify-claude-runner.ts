/**
 * Assertions for the Claude runner's security boundaries.
 *
 * These four controls are the ones that keep a prompt-injected agent from reaching
 * credentials or widening its own permissions, so they are asserted rather than
 * assumed. Run with:  npm run verify:claude
 *
 * Deliberately dependency-free and outside src/ (tsconfig includes only src/**),
 * so it never ends up in the build output. Supabase env vars are stubbed because
 * importing the runner pulls in db.ts, which requires them at module load.
 */
import path from "node:path";
import { redact, safeExtraArgs, resolveCwd } from "../src/modules/claude/runner";

let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <-- " + extra}`);
  if (!cond) fail++;
};

// --- redact(): captured events must not persist credentials ----------------
const tok = "sk-ant-oat01-" + "A".repeat(40);
ok("redacts an sk-ant token", !redact(`token=${tok}`).includes(tok));
const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
ok("redacts a JWT (the service-role key shape)", !redact(jwt).includes("eyJzdWIi"));
ok("redacts a GitHub token", redact("ghp_" + "b".repeat(36)).includes("[redacted-github-token]"));
ok("redacts a postgres URL password", !redact("postgresql://u:pass@h:5432/db").includes("pass"));
ok("leaves ordinary text untouched", redact("hello src/index.ts line 42") === "hello src/index.ts line 42");

// --- safeExtraArgs(): an env var must not smuggle in a permission flag -----
ok("drops --dangerously-skip-permissions", safeExtraArgs("--dangerously-skip-permissions").length === 0);
ok(
  "keeps an allowlisted flag from a mixed string",
  JSON.stringify(safeExtraArgs("--dangerously-skip-permissions --max-turns 5")) === '["--max-turns","5"]',
);
ok(
  "drops a rejected flag's value too, so it can't be read as a bare argument",
  JSON.stringify(safeExtraArgs("--permission-mode bypassPermissions --max-turns 3")) === '["--max-turns","3"]',
);
ok("supports the --flag=value form", JSON.stringify(safeExtraArgs("--max-turns=7")) === '["--max-turns=7"]');
ok("empty input yields empty output", safeExtraArgs("").length === 0);

// --- resolveCwd(): cwd decides which permissions are inherited -------------
delete process.env.CLAUDE_RUN_ALLOWED_ROOTS;
const noReq = resolveCwd(null);
ok("no directory requested falls back to process.cwd()", "cwd" in noReq && noReq.cwd === process.cwd());
ok("a directory requested with no roots configured is rejected", "error" in resolveCwd("/srv/repo"));

process.env.CLAUDE_RUN_ALLOWED_ROOTS = "/srv/app,/srv/other";
ok("an exact root is allowed", "cwd" in resolveCwd("/srv/app"));
ok("a subdirectory of a root is allowed", "cwd" in resolveCwd("/srv/app/packages/web"));
ok("traversal out of a root is rejected", "error" in resolveCwd("/srv/app/../../etc"));
ok("a sibling sharing the root's prefix is rejected", "error" in resolveCwd("/srv/app-secrets"));
const resolved = resolveCwd("/srv/app/./sub");
ok("the returned path is normalized", "cwd" in resolved && resolved.cwd === path.resolve("/srv/app/sub"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILING`);
process.exit(fail === 0 ? 0 : 1);
