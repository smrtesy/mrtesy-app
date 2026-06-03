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

/** Hostname without a leading "www.", for labelling generic links. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
