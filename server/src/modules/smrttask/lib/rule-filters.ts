export interface SkipRuleRow {
  trigger: string;
  rule_type: string;
  is_active: boolean;
}

export interface MessageHeaders {
  from?: string | null;
  to?: string | null;
  senderEmail?: string | null;
  /** Email Subject — needed for narrow rules whose clauses include
   *  subject_contains=, including composite triggers like
   *  `from=X&subject_contains=Y`. WhatsApp/Calendar items have no
   *  subject, so a composite rule that includes subject_contains
   *  cannot match those sources by design. */
  subject?: string | null;
}

export interface ParsedSkipRules {
  gmailQueryFilters: string[];
  shouldSkip(msg: MessageHeaders): boolean;
  /** Like shouldSkip, but returns the *trigger string* of the first skip rule
   *  that matched (e.g. "from=spam@x.com" or "from=a@b&subject_contains=c"),
   *  or null when nothing matched. Used by gmail-sync to write a meaningful
   *  skip reason into the log for auto-skipped emails. */
  skipMatch(msg: MessageHeaders): string | null;
}

const CLAUSE_RE = /^(from|sender|to|domain|category|subject_contains|subject)\s*=\s*(.+)$/i;
const CALENDAR_TRIGGER_RE = /^calendar\s*=\s*(.+)$/i;

function extractEmail(field: string): string {
  const m = field.match(/<([^>]+)>/);
  return (m ? m[1] : field).trim().toLowerCase();
}

interface Clause {
  key: string;
  value: string;
}

function parseClauses(trigger: string): Clause[] {
  // A trigger may be a single clause ("from=x@y.com") or several joined by
  // "&" ("from=x@y.com&subject_contains=Deployment Failed"). All clauses in
  // a composite trigger are AND-ed together — both at the Gmail query level
  // (emitted as a single -(... ...) group) and at runtime (shouldSkip).
  return trigger
    .split("&")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(CLAUSE_RE);
      if (!m) return null;
      const value = m[2].trim().toLowerCase();
      if (!value) return null;
      return { key: m[1].toLowerCase(), value };
    })
    .filter((c): c is Clause => c !== null);
}

/** Build the Gmail `q` exclusion fragment for a single clause. Returns "" when
 *  the clause has no Gmail representation (currently never, but kept for
 *  symmetry with future clause types). */
function clauseToGmailQuery(c: Clause): string {
  switch (c.key) {
    case "from":
    case "sender":
      return `from:${c.value}`;
    case "to":
      // `deliveredto:` matches TO, CC, and BCC — `to:` misses BCC recipients.
      return `deliveredto:${c.value}`;
    case "domain":
      // Domain excludes mail to OR from. For composite (AND) rules with a
      // domain clause we still use from: because the AND semantics make
      // "to:" + "from:" combined incoherent — domain-narrow rules are
      // unusual; the typical composite is from + subject_contains.
      return `from:${c.value}`;
    case "category":
      return `category:${c.value}`;
    case "subject_contains":
    case "subject": {
      const escaped = c.value.replace(/"/g, "");
      // Gmail tolerates unquoted single-token subjects, but multi-word
      // phrases need quotes to be matched as a contiguous substring.
      return `subject:"${escaped}"`;
    }
    default:
      return "";
  }
}

/** Build a runtime checker for a single clause. Returns null when the clause
 *  cannot be evaluated against {from, to, subject} at runtime (rare —
 *  category= falls into this bucket: it depends on Gmail's category
 *  classification, not on the raw headers). */
function clauseToRuntimeCheck(
  c: Clause,
): ((args: { from: string; to: string; subject: string }) => boolean) | null {
  switch (c.key) {
    case "from":
    case "sender":
      return ({ from }) => from === c.value || from.includes(c.value);
    case "to":
      return ({ to }) => to.includes(c.value);
    case "domain": {
      const suffix = `@${c.value}`;
      return ({ from, to }) => from.endsWith(suffix) || to.includes(suffix);
    }
    case "subject_contains":
    case "subject":
      return ({ subject }) => subject.includes(c.value);
    case "category":
      return null;
    default:
      return null;
  }
}

export function parseSkipRules(rules: SkipRuleRow[]): ParsedSkipRules {
  const skipRules = rules.filter(
    (r) => (r.rule_type === "skip" || r.rule_type === "skip_spam") && r.is_active,
  );

  const queryFilters: string[] = [];
  // Each check carries the trigger that produced it so skipMatch can report
  // *which* rule fired (for the log's skip reason), not just a boolean.
  const checks: Array<{ trigger: string; test: (args: { from: string; to: string; subject: string }) => boolean }> = [];

  for (const r of skipRules) {
    const clauses = parseClauses(r.trigger);
    if (clauses.length === 0) continue;

    // ── Gmail-side: emit either a single -clause or a grouped -(c1 c2 …)
    // when the trigger has more than one clause. Gmail interprets the
    // group as an AND: messages must match every clause inside the group
    // to be excluded — which is exactly the AND semantics we want for
    // composite rules like `from=alerts@vercel.com&subject_contains=Failed`.
    const gmailFrags = clauses.map(clauseToGmailQuery).filter(Boolean);
    if (gmailFrags.length === 1) {
      queryFilters.push(`-${gmailFrags[0]}`);
    } else if (gmailFrags.length > 1) {
      queryFilters.push(`-(${gmailFrags.join(" ")})`);
    }

    // ── Runtime: AND of the clauses' checkers. If any clause has no
    // runtime checker (e.g. category=) and the rule is composite, we skip
    // the runtime check for the rule overall — Gmail still filters at
    // fetch time, but stuff that slipped through won't be re-skipped by
    // shouldSkip. (shouldSkip currently has no callers, so this is
    // a safety net for future use.)
    const runtimeChecks = clauses.map(clauseToRuntimeCheck);
    if (runtimeChecks.every((c) => c !== null)) {
      const checkers = runtimeChecks as Array<NonNullable<(typeof runtimeChecks)[number]>>;
      checks.push({ trigger: r.trigger, test: (args) => checkers.every((check) => check(args)) });
    }
  }

  const skipMatch = ({ from, to, senderEmail, subject }: MessageHeaders): string | null => {
    const fromVal = extractEmail((senderEmail ?? from ?? "").toString());
    const toVal = (to ?? "").toString().toLowerCase();
    const subjectVal = (subject ?? "").toString().toLowerCase();
    const hit = checks.find((c) => c.test({ from: fromVal, to: toVal, subject: subjectVal }));
    return hit ? hit.trigger : null;
  };

  return {
    gmailQueryFilters: queryFilters,
    skipMatch,
    shouldSkip: (msg) => skipMatch(msg) !== null,
  };
}

export function parseCalendarSkips(rules: SkipRuleRow[]): Set<string> {
  const skips = new Set<string>();
  for (const r of rules) {
    if ((r.rule_type === "skip" || r.rule_type === "skip_spam") && r.is_active) {
      const m = r.trigger.match(CALENDAR_TRIGGER_RE);
      if (m) skips.add(m[1].trim());
    }
  }
  return skips;
}
