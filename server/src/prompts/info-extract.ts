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
KEEP: durable specifics someone would look up later — insurer/company names,
policy/account/reference numbers, due/payment/renewal dates, amounts, contact
details, addresses, ID numbers, plan names, who-is-responsible-for-what, and
WHERE a credential lives (not the secret itself).
DROP (emit no fact): small talk, greetings, opinions, one-off logistics that
expire immediately, marketing/newsletters/promotions, task requests ("please
send X"), and anything not reusable. Prefer FEWER, higher-value facts over many
trivial ones. If nothing is worth keeping, return {"facts":[]}.

If a fact's value is or contains a URL, keep it VERBATIM — full path, query and
fragment — never shortened to a bare domain.

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
