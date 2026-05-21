// Mirror of server/src/modules/smrttask/lib/rule-filters.ts — kept in sync
// so the edge functions (gmail-sync, initial-scan) honour the same skip-rule
// grammar the user-facing dismiss flow produces. If you change one, change
// the other.

export interface SkipRuleRow {
  trigger: string;
  rule_type: string;
  is_active: boolean;
}

export interface MessageHeaders {
  from?: string | null;
  to?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
}

export interface ParsedSkipRules {
  gmailQueryFilters: string[];
  shouldSkip(msg: MessageHeaders): boolean;
}

const CLAUSE_RE = /^(from|sender|to|domain|category|subject_contains|subject)\s*=\s*(.+)$/i;

function extractEmail(field: string): string {
  const m = field.match(/<([^>]+)>/);
  return (m ? m[1] : field).trim().toLowerCase();
}

interface Clause {
  key: string;
  value: string;
}

function parseClauses(trigger: string): Clause[] {
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

function clauseToGmailQuery(c: Clause): string {
  switch (c.key) {
    case "from":
    case "sender":
      return `from:${c.value}`;
    case "to":
      return `to:${c.value}`;
    case "domain":
      return `from:${c.value}`;
    case "category":
      return `category:${c.value}`;
    case "subject_contains":
    case "subject": {
      const escaped = c.value.replace(/"/g, "");
      return `subject:"${escaped}"`;
    }
    default:
      return "";
  }
}

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
  const checks: Array<(args: { from: string; to: string; subject: string }) => boolean> = [];

  for (const r of skipRules) {
    const clauses = parseClauses(r.trigger);
    if (clauses.length === 0) continue;

    const gmailFrags = clauses.map(clauseToGmailQuery).filter(Boolean);
    if (gmailFrags.length === 1) {
      queryFilters.push(`-${gmailFrags[0]}`);
    } else if (gmailFrags.length > 1) {
      queryFilters.push(`-(${gmailFrags.join(" ")})`);
    }

    const runtimeChecks = clauses.map(clauseToRuntimeCheck);
    if (runtimeChecks.every((c) => c !== null)) {
      const checkers = runtimeChecks as Array<NonNullable<(typeof runtimeChecks)[number]>>;
      checks.push((args) => checkers.every((check) => check(args)));
    }
  }

  return {
    gmailQueryFilters: queryFilters,
    shouldSkip: ({ from, to, senderEmail, subject }) => {
      const fromVal = extractEmail((senderEmail ?? from ?? "").toString());
      const toVal = (to ?? "").toString().toLowerCase();
      const subjectVal = (subject ?? "").toString().toLowerCase();
      return checks.some((check) => check({ from: fromVal, to: toVal, subject: subjectVal }));
    },
  };
}
