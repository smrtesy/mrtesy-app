/**
 * GitHub for Claude runs — "חיבור לגיטהאב שיאפשר חיבור לכל הריפו שלי".
 *
 * One token, stored the same way the subscription token is (app_secrets under the
 * platform app, with an environment-variable fallback), gives three things:
 *
 *   1. the list of repositories the token can reach, so a run is launched against
 *      a repo picked from a list instead of a path typed from memory;
 *   2. the last-commit date of a document, which is the "תאריך עדכון אחרון" the
 *      playbook list shows;
 *   3. a cloned working copy on the backend host, so the run has real files to
 *      read and can push a branch back.
 *
 * SECRET HANDLING — the rules this file follows without exception:
 *   • the token is never returned to a client, never logged, and never included
 *     in an error message. `redact()` scrubs it from anything that goes outward.
 *   • the clone URL embeds the token (the standard way to authenticate an
 *     ephemeral clone), so the workspace directory is deleted when the run ends
 *     and lives under the OS temp dir, never inside the repo or a served path.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAppSecret } from "../../db";

/** Same app as the subscription token: this is platform infrastructure shared by
 *  every run, not a feature of one product. Editable at
 *  /admin/apps/smrttask/secrets, with the Railway variable as a fallback. */
const TOKEN_APP_SLUG = "smrttask";
const TOKEN_KEY = "GITHUB_TOKEN";

const API = "https://api.github.com";
/** GitHub rejects requests without a User-Agent. */
const UA = "smrtesy-claude-console";
const REPOS_PER_PAGE = 100;
/** Ceiling on pagination: 5 × 100 repos is far past any real account, and it
 *  stops a pathological token from turning one click into 50 API calls. */
const MAX_REPO_PAGES = 5;
const FETCH_TIMEOUT_MS = 15_000;

export interface GitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
}

export async function getGitHubToken(): Promise<string | null> {
  return (await getAppSecret(TOKEN_APP_SLUG, TOKEN_KEY, TOKEN_KEY))?.trim() || null;
}

/** Strip the token from any text that leaves this module (error messages, git
 *  stderr — git prints the remote URL, token included, on a failed clone). */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("***");
}

/** Build the canonical blob deep link for a repo file — full path and branch, so
 *  one click lands on the file itself (CLAUDE.md "preserve deep links"). */
export function blobUrl(repo: string, branch: string, filePath: string): string {
  return `https://github.com/${repo}/blob/${branch}/${filePath}`;
}

async function gh(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every repo the token can reach — owned, collaborator, and organization member.
 *
 * `affiliation` is spelled out rather than left to the default: the default
 * (owner,collaborator,organization_member) happens to match today, but relying on
 * a remote default is exactly the class of assumption that breaks silently.
 */
export async function listRepos(token: string): Promise<GitHubRepo[]> {
  const out: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const url =
      `${API}/user/repos?per_page=${REPOS_PER_PAGE}&page=${page}` +
      "&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member";
    const res = await gh(url, token);
    if (!res.ok) {
      throw new Error(`GitHub ${res.status}: ${redact(await res.text(), token).slice(0, 300)}`);
    }
    const batch = (await res.json()) as Record<string, unknown>[];
    for (const r of batch) {
      out.push({
        full_name: String(r.full_name ?? ""),
        private: !!r.private,
        default_branch: String(r.default_branch ?? "main"),
        pushed_at: typeof r.pushed_at === "string" ? r.pushed_at : null,
        html_url: String(r.html_url ?? ""),
      });
    }
    if (batch.length < REPOS_PER_PAGE) break;
  }
  return out;
}

/** owner/repo, the only shape the clone and API calls accept. Anything else is a
 *  caller bug or an injection attempt and is refused rather than interpolated. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export function isValidRepo(repo: string): boolean {
  if (!REPO_RE.test(repo)) return false;
  // GitHub names may contain dots, so the character class alone would accept
  // "owner/.." — and cloneWorkspace joins that name onto the temp base, which
  // would resolve OUTSIDE it. Reject any relative-path segment explicitly.
  return repo.split("/").every((seg) => seg !== "." && seg !== ".." && !seg.includes(".."));
}

/** Git refuses these anyway, but validating here keeps a crafted branch name out
 *  of the argv we build. */
const BRANCH_RE = /^[A-Za-z0-9._\-/]{1,200}$/;
export function isValidBranch(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.includes("..") && !branch.startsWith("-");
}

/**
 * The committer date of the last commit that touched one file — the document's own
 * "last updated", which is a different fact from when someone last edited our copy
 * of its instructions.
 */
export async function fileLastCommitDate(repo: string, filePath: string): Promise<string | null> {
  if (!isValidRepo(repo)) return null;
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not configured");

  const url = `${API}/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=1`;
  const res = await gh(url, token);
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${redact(await res.text(), token).slice(0, 200)}`);
  }
  const commits = (await res.json()) as Record<string, any>[];
  const date = commits?.[0]?.commit?.committer?.date ?? commits?.[0]?.commit?.author?.date;
  return typeof date === "string" ? date : null;
}

function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "ignore", "pipe"],
      // Never let git open an interactive credential prompt on the server: a
      // missing/expired token must fail fast instead of hanging the run.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += String(c);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: `${stderr}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const CLONE_TIMEOUT_MS = 120_000;

export interface Workspace {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Clone a repo into a throwaway workspace the run can work in.
 *
 * Depth 1 on a single branch: a run needs the current tree, not the history, and a
 * shallow clone of a large repo is the difference between seconds and minutes.
 * `git config user.*` is set locally so a commit the run makes has an author —
 * without it git aborts the commit and the run's work would be unpushable.
 *
 * The token rides in the remote URL, which is what lets the run push back. That
 * URL is written into .git/config, so `cleanup()` deleting the directory is part
 * of the security model, not just tidiness — the caller must always call it.
 */
export async function cloneWorkspace(
  repo: string,
  branch: string | null,
  token: string,
): Promise<Workspace> {
  if (!isValidRepo(repo)) throw new Error(`invalid repo: ${repo}`);
  if (branch && !isValidBranch(branch)) throw new Error(`invalid branch: ${branch}`);

  const base = await mkdtemp(path.join(os.tmpdir(), "claude-ws-"));
  const dir = path.join(base, repo.split("/")[1]);
  const cleanup = () => rm(base, { recursive: true, force: true }).catch(() => {});

  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const args = ["clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  // "--" so the two positionals can never be parsed as options. The URL is always
  // https-prefixed, but a repo name may legally start with "-" and `git clone … -foo`
  // would read as a flag.
  args.push("--", url, dir);

  const { code, stderr } = await run("git", args, { timeoutMs: CLONE_TIMEOUT_MS });
  if (code !== 0) {
    await cleanup();
    const hint =
      code === null && /ENOENT/.test(stderr)
        ? "git is not installed on the backend host (add it to server/nixpacks.toml nixPkgs)"
        : redact(stderr.trim(), token).slice(0, 600);
    throw new Error(`git clone failed for ${repo}: ${hint}`);
  }

  // Local config only — it must not leak into the host's global git identity.
  await run("git", ["config", "user.name", "smrtesy Claude"], { cwd: dir, timeoutMs: 10_000 });
  await run("git", ["config", "user.email", "claude@smrtesy.local"], { cwd: dir, timeoutMs: 10_000 });

  return { dir, cleanup };
}
