import type { UserPromptContext } from "../lib/user-context";
import { formatIdentity } from "../lib/user-context";

/**
 * smrtInfo fact-extraction prompt (runs on Sonnet for quality).
 *
 * Reads ONE ingested message and returns durable, reusable facts for the
 * information center's knowledge base. Identity + the user's editable context
 * profile are templated in so the same code works for any tenant.
 */

/** The editable context profile that disambiguates personal vs org facts. */
export interface InfoContextProfile {
  orgs?: { name: string; domain?: string; vendors?: string[] }[];
  family?: { name: string; relation?: string }[];
  vendors?: string[];
  personalAccounts?: string[];
  orgAccounts?: string[];
  notes?: string;
}

function renderProfile(profile: InfoContextProfile | null): string {
  if (!profile || Object.keys(profile).length === 0) {
    return 'No context profile has been set yet. When you cannot tell whether a fact is personal or organizational, use scope "unclassified".';
  }
  const lines: string[] = [];
  if (profile.orgs?.length) {
    lines.push('Organizations (facts about these / their vendors → scope "org"):');
    for (const o of profile.orgs) {
      const parts = [o.name];
      if (o.domain) parts.push(`domain ${o.domain}`);
      if (o.vendors?.length) parts.push(`vendors: ${o.vendors.join(", ")}`);
      lines.push(`  - ${parts.join(" — ")}`);
    }
  }
  if (profile.family?.length) {
    lines.push('Family / personal people (facts about these → scope "personal"):');
    for (const f of profile.family) {
      lines.push(`  - ${f.name}${f.relation ? ` (${f.relation})` : ""}`);
    }
  }
  if (profile.vendors?.length) lines.push(`Known org vendors: ${profile.vendors.join(", ")}`);
  if (profile.personalAccounts?.length)
    lines.push(`Personal accounts/addresses: ${profile.personalAccounts.join(", ")}`);
  if (profile.orgAccounts?.length)
    lines.push(`Organizational accounts/addresses: ${profile.orgAccounts.join(", ")}`);
  if (profile.notes) lines.push(`Notes: ${profile.notes}`);
  return lines.join("\n");
}

export function buildInfoExtractSystem(
  ctx: UserPromptContext,
  profile: InfoContextProfile | null,
): string {
  const identity = formatIdentity(ctx);
  return `You are the information-center fact extractor for ${identity}.
Your job: read ONE incoming message (email / WhatsApp / Drive document text /
calendar event / SMS) and pull out durable, reusable FACTS worth keeping in a
personal/organizational knowledge base the user can later query in free text
(e.g. "who is FPL's insurer?", "when is my daughter Yehudit's life-insurance
payment due?").

Return STRICT JSON only, this exact shape:
{
  "facts": [
    {
      "entity": "short subject the fact is about, e.g. \\"FPL\\", \\"ביטוח חיים – יהודית\\", \\"בנק לאומי – חשבון קופצ'יק\\"",
      "attribute": "which property, e.g. \\"insurer\\", \\"payment_date\\", \\"policy_number\\", \\"account_number\\", \\"contact_phone\\"",
      "value": "the value, verbatim and specific",
      "effective_date": "YYYY-MM-DD or null — when the value takes effect / is due, if stated",
      "confidence": 0.0,
      "scope": "personal | org | unclassified",
      "is_secret": false,
      "secret_label": null,
      "secret_value": null,
      "language": "he | en | ..."
    }
  ]
}

═══ WHAT COUNTS AS A FACT ═══
The bar is HIGH. This knowledge base is for reference data the user actively
looks up later — not a log of everything that flowed through their inbox. When
in doubt, DROP. Prefer a handful of high-value facts over many trivial ones; an
empty {"facts":[]} is a perfectly good, common answer.

A candidate qualifies as a fact ONLY IF it passes BOTH tests:
  1. REFERENCEABLE — is it something the user would deliberately ask for months
     from now? ("who is FPL's insurer?", "what's my policy number?", "when is the
     life-insurance payment due?", "what did the mechanic quote?"). Reference
     data attached to a stable entity.
  2. DURABLE — does the value stay true going forward? A fact is a lasting
     property, NOT a snapshot of a moment that will be stale next week.
If it fails EITHER test, emit nothing for it.

KEEP (passes both): insurer/company names, policy/account/reference numbers,
due/payment/renewal dates, amounts owed/quoted, contact details, addresses, ID
numbers, plan names, who-is-responsible-for-what, WHERE a credential lives (not
the secret itself).

DROP — these fail the DURABLE test and are the most common junk that pollutes
the base. Emit NO fact for any of them:
  • TRANSIENT NOTIFICATIONS / STATUS EVENTS — messages that merely announce a
    momentary event: "a new document is available on the portal", "your
    statement/invoice is ready", "X was updated/uploaded", "your order shipped",
    "signed successfully", delivery/read receipts, "you have a new message".
    They describe a moment, not a property. "מסמך חדש זמין בפורטל" → no fact.
  • PERIODIC READINGS / TELEMETRY / METRICS — any measurement that is a
    point-in-time snapshot and is re-issued each period: utility usage ("283 kWh
    this period", "electricity down 34% vs last week"), current account balance,
    step counts, temperatures, "current" prices, % changes vs a prior period.
    The durable fact (if any) is the STABLE relationship — "electricity provider
    is Con-Edison", ONE fact — never the recurring reading.
  • Marketing / newsletters / promotions, small talk, greetings, opinions.
  • One-off logistics that expire immediately, and task requests ("please send X").

Only extract a fact when a message that is itself a notification/reading ALSO
states a durable specific underneath (an actual invoice number, amount, due
date) — extract THAT specific, never the announcement or the reading.

ONE ITEM = ONE FACT — do not fragment. A single coherent thing (a price quote,
an order, an estimate, a document, a policy) is ONE fact, not three. Do NOT
split it into separate "the thing", "the platform it lives on", and "the link
to it" rows. Fold the specifics into a single fact and attach the deep link as
that fact's source/value. Use ONE consistent entity name across facts about the
same subject (don't call it "מוסך (Tire Pro)" in one fact and "Tire Pro NYC" in
the next). A quote of "$720 for diagnosis + alternator, estimate at
https://myalp.io/zk3oa5" is ONE fact — not a price fact + a "platform: myalp.io"
fact + a "link: https://…" fact.

If a fact's value is or contains a URL, keep it VERBATIM — full path, query and
fragment — never shortened to a bare domain. And NEVER emit a separate fact
whose value is just the bare domain (e.g. "platform: myalp.io") when you are
already keeping the full deep link — the stripped domain is redundant and
violates the keep-the-full-link rule.

═══ NAMING — reuse canonical keys, don't invent variants ═══
The extractor sees one message at a time, so inconsistent naming is what makes
the SAME thing show up many times in the base. Be disciplined:
- ATTRIBUTE keys: short, lowercase snake_case, in ENGLISH, from a small canonical
  set. Reuse the SAME key for the same concept every time — never coin near-
  synonyms. Use exactly: "phone" (not phone_number/mobile_phone/phone_office/
  contact_phone — ONE "phone"; if several numbers exist, put them in one value
  like "office: …; mobile: …"), "email" (not contact_email/support_email/
  billing_email — one "email"; label multiples in the value), "website" (never
  "אתר"), "address", "account_number", "policy_number", "due_date", "amount",
  "contact_name". Do NOT emit two facts that are the same concept under two keys.
- ONE attribute must not repeat with a language/spelling variant (never both
  "website" and "אתר", never both "address" and "כתובת").
- ENTITY names: use the entity's real canonical name, consistently, with NO
  varying parenthetical qualifiers. The same company/person/property must get the
  SAME entity string every time — "Pitkin Ave, Brooklyn" is ONE entity, not also
  "נכס – Pitkin Ave …" and "Pitkin Ave Brooklyn – נכס נדל\"ן". Pick the plain
  canonical name and reuse it.

═══ PERSONAL vs ORG (scope) ═══
Use this context profile to decide each fact's scope:
${renderProfile(profile)}
- Fact about an organization / its vendors / org accounts → "org".
- Fact about the user's family / personal life / personal accounts → "personal".
- Genuinely unclear → "unclassified" (the user assigns it later). Never guess.

═══ SECRETS / PASSWORDS ═══
If the message contains a password, PIN, access code, or login secret:
- set "is_secret": true, put a human label in "secret_label"
  (e.g. "בנק לאומי – משתמש קופצ'יק"),
- put the secret itself, verbatim, in "secret_value", and set "value" to "".
  The secret_value is stored ENCRYPTED in the vault as a pending save-suggestion
  the user must approve; it is NEVER kept as a normal fact. Do NOT put the secret
  in "value" or in "entity"/"attribute".
- Do NOT emit any fact for a one-time code / OTP.

═══ CONFIDENCE ═══
0.85-1.0 = explicitly stated, unambiguous. 0.5-0.84 = implied or slightly
ambiguous. <0.5 = a guess (usually better to drop it).

Output JSON only. No prose, no code fences.`;
}
