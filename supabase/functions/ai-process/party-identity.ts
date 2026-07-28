// EXTRACTED FROM index.ts (2026-07-28) — pure helpers, no I/O, no Deno
// globals, so they can be unit-tested directly (see *_test.ts next to this
// file). Moved verbatim; every comment below documents a real production bug
// the rule exists to prevent. Keep them pure: the moment one of these needs
// `supabase` or `fetch`, it belongs back in index.ts.

/** Party identity — verified in code, never taken on the model's word (T1804). */

export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
export const PHONE_RE = /\+?\d[\d\-().\s]{6,}\d/g;


export function extractEmails(...vals: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(EMAIL_RE);
    if (m) for (const e of m) out.add(e.toLowerCase());
  }
  return out;
}

export function emailDomains(emails: Set<string>): Set<string> {
  const d = new Set<string>();
  for (const e of emails) {
    const i = e.indexOf("@");
    if (i > 0) {
      const dom = e.slice(i + 1);
      // Skip generic/no-reply sender domains that would over-match unrelated
      // automated mail. They carry no "same party" signal.
      if (!/^(gmail|googlemail|outlook|hotmail|yahoo|icloud)\./.test(dom)) d.add(dom);
    }
  }
  return d;
}

// Last 10 digits, so +1-212-908-6671 and (212) 908-6671 compare equal.
export function normPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function extractPhones(...vals: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const v of vals) {
    if (!v) continue;
    const m = String(v).match(PHONE_RE);
    if (m) for (const p of m) { const n = normPhone(p); if (n.length >= 9) out.add(n); }
  }
  return out;
}

export function extractUrls(text: string): string[] {
  const m = String(text).match(URL_RE);
  return m ? Array.from(new Set(m)) : [];
}

// ── Party identity — verified in code, never taken on the model's word ───────
// The AI gates below decide SAME MATTER. They must NEVER be the only authority
// on SAME PARTY: the cheap classification_model repeatedly manufactured an
// identity to justify a merge — "3475848008 = 347-584-8008, תואם 972584146670",
// "מספר טלפון 972537701510 מתאים ל-7706484073 כנראה שגיאת הקלדה" — and fused two
// unrelated people into one task. T1804 is the reference case: לאה's "she'll
// call back" task was renamed to מענדי's AI-voices ask, keeping לאה's contact and
// description; T276 then collected four more updates from the wrong chat because
// the bad link also re-pointed that chat's thread memory. Replaying the last 90
// days: of 105 two-party chat auto-merges, 81 were party-verified, 7 were
// unverifiable — and 15 had a provably different counterparty.
//
// So identity is checked deterministically: the channel counterparty of the
// incoming item vs the counterparty the candidate task records (its contact
// fields AND the message it was born from). A verified mismatch downgrades the
// verdict one tier instead of merging.
export interface PartyIds {
  emails: Set<string>;
  domains: Set<string>;
  /** Last-9-digit phone keys — country-code / leading-zero tolerant. */
  phones: Set<string>;
}

// Key on the last EIGHT digits, which is what survives every form the same
// number is written in here: +1-347-584-8008 / 3475848008 / 13475848008 → 75848008,
// +972-58-414-6670 / 058-414-6670 → 84146670, and — the reason it is 8 and not 9
// — an Israeli 9-digit landline written locally (03-123-4567) vs internationally
// (+972-3-123-4567), which extractPhones truncates to 7231234567: only the last
// 8 digits agree. Two genuinely different numbers still differ (75848008 ≠
// 84146670, the exact pair the model declared equal on T1804); a collision needs
// the same 7-digit subscriber number AND the same final area-code digit, and it
// would only cost a veto, never cause a wrong one.
export function phoneKeys(...vals: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const p of extractPhones(...vals)) if (p.length >= 9) out.add(p.slice(-8));
  return out;
}

export function partyIdsFrom(
  emailish: (string | null | undefined)[],
  phonish: (string | null | undefined)[],
): PartyIds {
  const emails = extractEmails(...emailish);
  return { emails, domains: emailDomains(emails), phones: phoneKeys(...phonish) };
}

// Who the INCOMING item is with: the channel counterparty ONLY — sender address,
// chat phone. Deliberately NOT the body: a number quoted inside a message is not
// the party, and scraping those is exactly how a "same phone" fantasy gets
// manufactured. Self-chat rows (whatsapp_echo/sms_echo) have no counterparty, so
// they yield no verdict and keep their existing behaviour.
export function msgPartyIds(msg: any): PartyIds {
  if (msg?.source_type === "whatsapp_echo" || msg?.source_type === "sms_echo") {
    return partyIdsFrom([], []);
  }
  const md = (msg?.metadata ?? {}) as any;
  // On the user's OWN outbound mail the sender is the user — the counterparty is
  // the recipient. metadata.to is used for gmail_sent ONLY: on incoming mail it
  // holds the user's own alias, and folding that in would make every pair of
  // emails "share a party" and disable the check entirely.
  if (msg?.source_type === "gmail_sent") return partyIdsFrom([md?.to], []);
  return partyIdsFrom([msg?.sender_email, msg?.sender], [md?.fromPhone, md?.peerPhone, md?.chatId]);
}

/** Who a candidate TASK is with, from the contact fields the builder filled. */
export function taskPartyIds(task: any): PartyIds {
  return partyIdsFrom(
    [task?.related_contact_email, task?.related_contact],
    [task?.related_contact_phone, task?.related_contact],
  );
}

export function mergeParties(a: PartyIds, b: PartyIds): PartyIds {
  return {
    emails: new Set([...a.emails, ...b.emails]),
    domains: new Set([...a.domains, ...b.domains]),
    phones: new Set([...a.phones, ...b.phones]),
  };
}

// mail.dep.nyc.gov and dep.nyc.gov are the same authority (the DEP dunning case
// the matcher must keep merging); a.com and b.com are not.
export function domainsRelated(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * True only when the two sides carry COMPARABLE identifiers of the same kind
 * (phone↔phone or email↔email) and they are verifiably NOT the same party.
 *
 * Two deliberate non-verdicts, so this stays a mismatch detector and not a
 * blanket "different source" block:
 *  • One side anonymous (a calendar event, a Drive scan, a task with no contact)
 *    — nothing to compare, and those are the genuine cross-source links this
 *    matcher exists for.
 *  • Nothing comparable (a WhatsApp phone vs a task known only by email) — a
 *    person can own both, so this is UNVERIFIABLE, not proven different.
 * A match on ANY kind clears the whole check: a shared email is identity even if
 * some phone in the free-text contact field differs.
 */
export function partiesConflict(incoming: PartyIds, task: PartyIds): boolean {
  const comparable =
    (incoming.phones.size > 0 && task.phones.size > 0) ||
    (incoming.emails.size > 0 && task.emails.size > 0);
  return comparable && !partiesMatch(incoming, task);
}

/** A POSITIVE identity match — a shared phone, address, or related domain. */
export function partiesMatch(a: PartyIds, b: PartyIds): boolean {
  for (const p of a.phones) if (b.phones.has(p)) return true;
  for (const e of a.emails) if (b.emails.has(e)) return true;
  for (const d of a.domains) for (const d2 of b.domains) if (domainsRelated(d, d2)) return true;
  return false;
}

/**
 * The task's own TEXT already names the incoming counterparty (their number or
 * address appears in its title/description) → they really are involved in this
 * matter even though the contact fields point elsewhere. This is the evidence
 * that rescues the legitimate case: a person replying from their own number
 * about a matter opened through someone else (T1086 — Rabbi Nagel's number is
 * written in the task the model matched). Evidence in the data, not a claim in
 * the reason string.
 */
export function taskTextNamesParty(task: any, incoming: PartyIds): boolean {
  const blob = `${task?.title_he ?? ""} ${task?.title ?? ""} ${String(task?.description ?? "")}`;
  const ids = partyIdsFrom([blob], [blob]);
  if (partiesMatch(incoming, ids)) return true;
  // Domain named in the text, even without a full address: covers a vendor that
  // rotates sending domains (billing@x.com → notices@x-mail.net) where the task
  // itself says who it is about. Generic consumer domains are already filtered
  // out of PartyIds.domains, so "gmail.com" can never rescue a merge.
  const lower = blob.toLowerCase();
  for (const d of incoming.domains) if (lower.includes(d)) return true;
  return false;
}

/** Compact "who" for the audit trail in the log / ✨ panel. */
export function describeParty(p: PartyIds): string {
  const ids = [...p.phones, ...p.emails];
  return ids.length ? ids.slice(0, 3).join(", ") : "—";
}
