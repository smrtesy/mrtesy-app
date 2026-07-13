import type { Task } from "@/types/task";

// Kinds we render a purpose-built button for. Everything else is "generic"
// (we show the bare hostname so the user still knows where it leads).
export type LinkKind =
  | "zoom"
  | "meet"
  | "teams"
  | "doc"
  | "sheet"
  | "slides"
  | "drive"
  | "calendar"
  | "gmail"
  | "whatsapp"
  | "generic";

export interface DetectedLink {
  /** The exact URL, verbatim — query params and fragments preserved so one
   *  click lands the user on the right page (product "preserve deep links" rule). */
  url: string;
  kind: LinkKind;
}

export interface ActionNugget extends DetectedLink {
  /** AI-provided short Hebrew label for the button ("מעקב ותשלום"). When absent
   *  the UI falls back to the kind label / bare host, same as a plain link. */
  label?: string;
}

// Bare-URL matcher. Stops before whitespace, quotes/brackets, and a trailing
// ")" so a parenthesised "(see https://x.com/a)" doesn't swallow the paren.
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

// Domain match anchored on a dot boundary, so "evilzoom.us" does NOT match
// "zoom.us" — only "zoom.us" itself and real subdomains like "x.zoom.us".
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

function classify(url: string): LinkKind {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (hostIs(host, "zoom.us") || hostIs(host, "zoom.com")) return "zoom";
  if (host === "meet.google.com") return "meet";
  if (hostIs(host, "teams.microsoft.com") || hostIs(host, "teams.live.com")) return "teams";
  if (host === "docs.google.com") {
    if (url.includes("/spreadsheets/")) return "sheet";
    if (url.includes("/presentation/")) return "slides";
    return "doc";
  }
  if (host === "drive.google.com") return "drive";
  if (host === "calendar.google.com") return "calendar";
  if (host === "mail.google.com") return "gmail";
  if (host === "wa.me" || hostIs(host, "whatsapp.com")) return "whatsapp";
  return "generic";
}

/**
 * Collect the actionable links attached to a task — URLs embedded in the
 * description plus structured material/drive-doc URLs — deduped in first-seen
 * order, each classified so the UI can label it ("Join Zoom", "Open doc", …).
 * Lets the user act on a task (join a meeting, open a doc) without opening it.
 */
export function extractTaskLinks(
  task: Pick<Task, "description" | "task_materials" | "linked_drive_docs">,
): DetectedLink[] {
  const raw: string[] = [];

  if (task.description) {
    for (const m of task.description.matchAll(URL_RE)) raw.push(m[0]);
  }
  for (const mat of task.task_materials ?? []) {
    if (mat.url) raw.push(mat.url);
  }
  for (const doc of task.linked_drive_docs ?? []) {
    if (doc.url) raw.push(doc.url);
  }

  const seen = new Set<string>();
  const out: DetectedLink[] = [];
  for (const u of raw) {
    // Drop a trailing sentence period/comma a regex grab can pick up. We leave
    // ";" alone — it's valid inside query strings.
    const url = u.replace(/[.,]+$/, "");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: classify(url) });
  }
  return out;
}

/**
 * The task's "action nuggets" — small labeled buttons that take the user
 * straight to a destination in one click. Source order:
 *   1. AI-extracted `action_links` (each carries an explicit Hebrew label);
 *   2. fallback — bare URLs still embedded in the description (older tasks
 *      built before nuggets, or ones the builder missed);
 *   3. when `includeAttachments`, the structured material / drive-doc URLs too.
 * Deduped by URL in first-seen order. The card lists attachments here (one
 * button row); the run view opts out of (3) since it shows those in its own
 * attachments block.
 */
export function taskActionNuggets(
  task: Pick<Task, "description" | "task_materials" | "linked_drive_docs" | "action_links">,
  opts: { includeAttachments?: boolean } = {},
): ActionNugget[] {
  const seen = new Set<string>();
  const out: ActionNugget[] = [];
  const add = (rawUrl: string | undefined | null, label?: string | null) => {
    if (!rawUrl) return;
    // Drop a trailing sentence period/comma a regex grab can pick up (";" is
    // valid inside query strings, so it's left alone).
    const url = String(rawUrl).replace(/[.,]+$/, "");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    const trimmed = label?.trim();
    out.push({ url, kind: classify(url), label: trimmed ? trimmed : undefined });
  };
  // 1. AI nuggets. Guard the shape — the model occasionally returns a non-array.
  if (Array.isArray(task.action_links)) {
    for (const n of task.action_links) add(n?.url, n?.label);
  }
  // 2. Fallback: URLs the builder left in the body.
  if (task.description) {
    for (const m of task.description.matchAll(URL_RE)) add(m[0]);
  }
  // 3. Structured attachments (card only).
  if (opts.includeAttachments) {
    for (const mat of task.task_materials ?? []) add(mat.url);
    for (const doc of task.linked_drive_docs ?? []) add(doc.url);
  }
  return out;
}

/** Hostname without a leading "www.", for labelling generic links. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
