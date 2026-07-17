#!/usr/bin/env node
/**
 * Builds the JSON body for the smrtTask session-proposal endpoint from a Claude
 * Code Stop-hook payload (read on stdin). Prints the body to stdout, or nothing
 * (exit 0) when there's nothing worth filing — the wrapper skips the POST then.
 *
 * Everything is best-effort and guarded: this must never throw in a way that
 * blocks or fails a turn.
 *
 * Derived automatically from the Claude Code environment:
 *   session_id / session_url  <- CLAUDE_CODE_REMOTE_SESSION_ID (`cse_<slug>` ->
 *                                https://claude.ai/code/session_<slug>)
 *   user_email                <- CLAUDE_CODE_USER_EMAIL
 *   git_branch                <- <cwd>/.git/HEAD
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 24_000;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Flatten a transcript-entry message.content into plain text (skip tool noise). */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      out.push(block.text);
    }
  }
  return out.join("\n");
}

function buildTranscript(path) {
  if (!path) return "";
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  const parts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const entry = safeParse(t);
    if (!entry) continue;
    const msg = entry.message;
    const role = msg?.role ?? entry.role ?? entry.type;
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent(msg?.content ?? entry.content ?? "").trim();
    if (!text) continue;
    parts.push(`${role === "user" ? "מפתח" : "Claude"}: ${text}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > MAX_CHARS ? joined.slice(-MAX_CHARS) : joined;
}

function gitBranch(cwd) {
  try {
    const head = readFileSync(join(cwd || process.cwd(), ".git", "HEAD"), "utf8").trim();
    const m = head.match(/ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const hook = safeParse(readStdin()) ?? {};

// Stable web-session id/url from the environment; fall back to the hook's id.
const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || "";
const slug = remote.startsWith("cse_") ? remote.slice(4) : remote;
const sessionId = remote || hook.session_id || "";
if (!sessionId) process.exit(0);
const sessionUrl = slug ? `https://claude.ai/code/session_${slug}` : null;

const transcript = buildTranscript(hook.transcript_path);

// Identity: the smrtTask account to file for. The Claude Code login email can
// differ from the smrtesy platform account email (e.g. a maor.org login vs a
// gmail.com platform account), so honor explicit overrides first; the backend
// prefers user_id, then user_email.
const body = {
  session_id: sessionId,
  session_url: sessionUrl,
  user_id: process.env.SMRTTASK_USER_ID || null,
  user_email:
    process.env.SMRTTASK_USER_EMAIL || process.env.CLAUDE_CODE_USER_EMAIL || null,
  repo: "mrtesy-app",
  git_branch: gitBranch(hook.cwd),
  transcript,
};

process.stdout.write(JSON.stringify(body));
