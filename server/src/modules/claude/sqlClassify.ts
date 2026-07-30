/**
 * Classify a migration's SQL as ADDITIVE (reversible → autonomous) or DESTRUCTIVE
 * (irreversible → human click), per docs/claude-console/autonomy-safety-gate.md.
 *
 * SAFETY MODEL — allowlist, fail closed. A statement is additive ONLY if it matches a
 * known-safe, data-preserving shape. Anything else — anything we cannot positively
 * prove is non-destructive — is classified DESTRUCTIVE, so it routes to the human.
 * Over-asking is the accepted cost; silently applying a DROP is not. This mirrors the
 * CLAUDE.md rule "a model may propose; only code may confirm" — the classifier is the
 * code check that a migration's own description ("just adds a column") is not trusted.
 *
 * This is a coarse gate, not a full SQL parser. It is deliberately conservative: the
 * worst it can do is send a safe migration to the human for one extra click.
 */

export interface SqlClassification {
  additive: boolean;
  /** The raw statements that were NOT provably additive — shown to the human. */
  destructiveStatements: string[];
  /** Plain reasons, for the audit trail and the approval screen. */
  reasons: string[];
}

/**
 * Strip comments and string/identifier literals so the keyword scan can't be fooled
 * by a `DROP` sitting inside a comment or a quoted string. Replaced with spaces (not
 * removed) so statement boundaries and word boundaries are preserved.
 */
function stripNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // line comment  -- … \n
    if (two === "--") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // block comment /* … */
    if (two === "/*") {
      i += 2;
      while (i < n && sql.slice(i, i + 2) !== "*/") i++;
      i += 2;
      out += " ";
      continue;
    }
    // single-quoted string '…'  ('' escapes a quote)
    if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += " '' "; // keep a placeholder token
      continue;
    }
    // dollar-quoted string $tag$ … $tag$ (function bodies)
    if (sql[i] === "$") {
      const m = /^\$([A-Za-z0-9_]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " $$ ";
        continue;
      }
    }
    // double-quoted identifier "…"
    if (sql[i] === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      out += " id "; // preserve a token so "ADD" vs a quoted col don't merge
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/** Split cleaned SQL into statements on top-level semicolons. Dollar-quoted bodies are
 *  already collapsed by stripNoise, so a `;` inside a function body cannot appear. */
function splitStatements(clean: string): string[] {
  return clean
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Is one statement provably additive (data-preserving and reversible)?
 *
 * The allowlist is intentionally narrow. `norm` is the statement upper-cased with runs
 * of whitespace collapsed, so multi-word prefixes match regardless of formatting.
 */
function isAdditiveStatement(norm: string): boolean {
  const A = [
    // create things — nothing exists to lose
    /^CREATE TABLE\b/,
    /^CREATE (UNIQUE )?INDEX\b/,
    /^CREATE (OR REPLACE )?VIEW\b/,
    /^CREATE MATERIALIZED VIEW\b/,
    /^CREATE SCHEMA\b/,
    /^CREATE EXTENSION\b/,
    /^CREATE SEQUENCE\b/,
    /^CREATE (OR REPLACE )?FUNCTION\b/,
    /^CREATE (OR REPLACE )?PROCEDURE\b/,
    /^CREATE (OR REPLACE )?TRIGGER\b/,
    /^CREATE POLICY\b/,
    /^CREATE TYPE\b/,
    // metadata / permissions — no data touched
    /^COMMENT ON\b/,
    /^GRANT\b/,
    /^REVOKE\b/,
    /^ALTER TABLE .* ENABLE ROW LEVEL SECURITY$/,
    /^ALTER TABLE .* DISABLE ROW LEVEL SECURITY$/,
  ];
  if (A.some((re) => re.test(norm))) return true;

  // ALTER TABLE is the tricky one: ADD COLUMN / ADD CONSTRAINT / SET DEFAULT are
  // additive, but DROP COLUMN / ALTER COLUMN TYPE / SET NOT NULL are not. Only accept
  // the safe ADD/SET-DEFAULT shapes, and ONLY when the statement contains no risky
  // verb at all (so "ADD COLUMN x, DROP COLUMN y" in one ALTER is rejected).
  if (/^ALTER TABLE\b/.test(norm)) {
    const risky = /\b(DROP|TYPE|USING|SET NOT NULL|ALTER COLUMN|RENAME)\b/.test(norm);
    const safeAdd = /\bADD (COLUMN |CONSTRAINT )/.test(norm);
    const safeDefault = /\bALTER COLUMN\b.*\bSET DEFAULT\b/.test(norm); // excluded by `risky` above anyway
    if (!risky && (safeAdd || safeDefault)) return true;
    // A bare `ALTER TABLE … ADD COLUMN IF NOT EXISTS` with no risky verb is the common
    // case and is already covered by safeAdd + !risky.
    return false;
  }

  return false;
}

/** Human-readable reason for why a statement is treated as destructive. */
function destructiveReason(norm: string): string {
  if (/^DROP\b/.test(norm)) return "מוחק אובייקט (DROP)";
  if (/\bDROP COLUMN\b/.test(norm)) return "מוחק עמודה (DROP COLUMN)";
  if (/^DELETE\b/.test(norm)) return "מוחק שורות (DELETE)";
  if (/^TRUNCATE\b/.test(norm)) return "מרוקן טבלה (TRUNCATE)";
  if (/^UPDATE\b/.test(norm)) return "משנה נתונים קיימים (UPDATE)";
  if (/^INSERT\b/.test(norm)) return "כותב נתונים (INSERT)";
  if (/\bALTER COLUMN\b.*\bTYPE\b/.test(norm) || /\bUSING\b/.test(norm)) return "משנה טיפוס עמודה — עלול לאבד נתונים";
  if (/\bSET NOT NULL\b/.test(norm)) return "מוסיף NOT NULL — עלול להיכשל על נתונים קיימים";
  if (/^ALTER TYPE\b/.test(norm)) return "משנה טיפוס (ALTER TYPE)";
  return "לא ניתן לוודא שהפעולה תוספתית — מטופל כהרסני";
}

/**
 * Classify a whole migration. Additive only if EVERY statement is provably additive;
 * a single non-additive statement makes the migration destructive (fail closed).
 */
export function classifyMigrationSql(sql: string): SqlClassification {
  const clean = stripNoise(sql);
  const statements = splitStatements(clean);

  if (statements.length === 0) {
    // Nothing parseable — do not treat "empty" as safe; a migration that ran to here
    // with no recognizable statements is exactly the ambiguous case to route to a human.
    return { additive: false, destructiveStatements: [], reasons: ["לא זוהו הצהרות SQL תקינות"] };
  }

  const destructiveStatements: string[] = [];
  const reasons: string[] = [];
  for (const stmt of statements) {
    const norm = stmt.replace(/\s+/g, " ").trim().toUpperCase();
    if (!isAdditiveStatement(norm)) {
      destructiveStatements.push(stmt);
      reasons.push(destructiveReason(norm));
    }
  }

  return {
    additive: destructiveStatements.length === 0,
    destructiveStatements,
    reasons: Array.from(new Set(reasons)),
  };
}
