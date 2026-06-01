// Shared Gmail review-label helpers for the smrtTask edge functions.
//
// MIRROR NOTE: `ai-process/index.ts` carries its own private copy of
// GMAIL_REVIEW_LABELS / reviewLabelFor / listGmailLabels /
// getOrCreateGmailLabels (it wires them into its per-run token + label-map
// caches and its own log_entries error reporting). The label *values* here
// MUST stay byte-identical to ai-process's so both functions write the SAME
// nested Gmail label — otherwise a sync-skip and an ai-process-skip would
// land in two different labels. If you rename a label in one place, rename it
// in the other in the same commit.

// Nested Gmail labels: "Parent/Child" renders as a tree in Gmail.
export const GMAIL_REVIEW_LABELS = {
  skip:          "smrtTask/דילוג",
  informational: "smrtTask/אינפו",
  actionable:    "smrtTask/הצעה",
  update:        "smrtTask/עדכון",
} as const;

export type ReviewKind = keyof typeof GMAIL_REVIEW_LABELS;

// Map a final classification string to a review-label kind (or null when the
// classification has no label). Lowercased so legacy uppercase values still map.
export function reviewLabelFor(classification: string): ReviewKind | null {
  switch (String(classification).toLowerCase()) {
    case "skip":
    case "skipped":
    case "spam":
      return "skip";
    case "informational":
      return "informational";
    case "actionable":
      return "actionable";
    case "actionable_followup":
    case "informational_followup":
    case "update":
      return "update";
    default:
      return null;
  }
}

export async function listGmailLabels(token: string): Promise<Map<string, string>> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`labels.list ${resp.status}`);
  const map = new Map<string, string>();
  for (const l of (await resp.json()).labels ?? []) {
    if (l.name && l.id) map.set(l.name, l.id);
  }
  return map;
}

// Ensure each name exists as a label, creating any that are missing. A
// "Parent/Child" name renders as a nested label in Gmail.
export async function getOrCreateGmailLabels(token: string, names: string[]): Promise<Map<string, string>> {
  const map = await listGmailLabels(token);
  for (const name of names) {
    if (map.has(name)) continue;
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    if (resp.ok) {
      const created = await resp.json();
      if (created.id) map.set(name, created.id);
    } else if (resp.status === 409) {
      // Concurrent run created it between our list and create — re-list.
      const refreshed = await listGmailLabels(token);
      const id = refreshed.get(name);
      if (id) map.set(name, id);
    }
  }
  return map;
}

// Attach BOTH the specific kind label (smrtTask/דילוג, …) AND the parent
// "smrtTask" label, and drop UNREAD — identical to ai-process's tagGmailReview
// body. Gmail's nested labels are independent, so tagging just the child
// leaves the parent empty. Returns true if the modify call was issued.
export async function applyReviewLabel(
  token: string,
  messageId: string,
  kind: ReviewKind,
  labelMap: Map<string, string>,
): Promise<boolean> {
  const specificId = labelMap.get(GMAIL_REVIEW_LABELS[kind]);
  if (!specificId) return false;
  const parentId = labelMap.get("smrtTask");
  const addLabelIds = parentId ? [specificId, parentId] : [specificId];
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds: ["UNREAD"] }),
  });
  return true;
}
