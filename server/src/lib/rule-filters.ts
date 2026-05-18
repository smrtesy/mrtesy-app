export interface SkipRuleRow {
  trigger: string;
  rule_type: string;
  is_active: boolean;
}

export interface MessageHeaders {
  from?: string | null;
  to?: string | null;
  senderEmail?: string | null;
}

export interface ParsedSkipRules {
  gmailQueryFilters: string[];
  shouldSkip(msg: MessageHeaders): boolean;
}

const TRIGGER_RE = /^(from|sender|to|domain|category)\s*=\s*(.+)$/i;
const CALENDAR_TRIGGER_RE = /^calendar\s*=\s*(.+)$/i;

function extractEmail(field: string): string {
  const m = field.match(/<([^>]+)>/);
  return (m ? m[1] : field).trim().toLowerCase();
}

export function parseSkipRules(rules: SkipRuleRow[]): ParsedSkipRules {
  const skipRules = rules.filter(
    (r) => (r.rule_type === "skip" || r.rule_type === "skip_spam") && r.is_active,
  );

  const queryFilters: string[] = [];
  const checks: Array<(from: string, to: string) => boolean> = [];

  for (const r of skipRules) {
    const m = r.trigger.match(TRIGGER_RE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().toLowerCase();
    if (!value) continue;

    if (key === "from" || key === "sender") {
      queryFilters.push(`-from:${value}`);
      checks.push((from) => from === value || from.includes(value));
    } else if (key === "to") {
      queryFilters.push(`-to:${value}`);
      checks.push((_, to) => to.includes(value));
    } else if (key === "domain") {
      queryFilters.push(`-from:${value}`);
      queryFilters.push(`-to:${value}`);
      const suffix = `@${value}`;
      checks.push((from, to) => from.endsWith(suffix) || to.includes(suffix));
    } else if (key === "category") {
      queryFilters.push(`-category:${value}`);
    }
  }

  return {
    gmailQueryFilters: queryFilters,
    shouldSkip: ({ from, to, senderEmail }) => {
      const fromVal = extractEmail((senderEmail ?? from ?? "").toString());
      const toVal = (to ?? "").toString().toLowerCase();
      return checks.some((check) => check(fromVal, toVal));
    },
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
