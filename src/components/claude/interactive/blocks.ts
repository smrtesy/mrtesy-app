/**
 * Interactive blocks inside a Claude answer — parsing.
 *
 * Why this exists: the in-app Claude console is a text stream (runner.ts spawns
 * the CLI and stores assistant text). To let Claude put an *editable plan* or an
 * *explained multiple-choice* on screen — where the user clicks instead of
 * typing, and the click is both the answer and the approval — Claude emits a
 * fenced block with a reserved info-string and a JSON body:
 *
 *   ```smrt-plan
 *   { "title": "…", "steps": ["…", "…"] }
 *   ```
 *
 *   ```smrt-ask
 *   { "question": "…",
 *     "options": [ { "label": "flux-pro", "detail": "הכי איכותי · ~$0.05" } ],
 *     "allowOther": true }
 *   ```
 *
 * The frontend splits an answer into ordered segments — plain markdown and these
 * blocks — and renders each. Answering a block is just a normal follow-up turn
 * (the engine session already holds the question in context), so this needs NO
 * new DB table and no engine change: the whole mechanism rides the existing
 * turn pipeline.
 *
 * Robustness: a block whose JSON is malformed or whose shape is wrong is left in
 * place as raw markdown (it renders as an ordinary code block), so a bad emit is
 * never lost or turned into a broken widget — it degrades to visible text.
 */

/** One choice in an `smrt-ask` block. `label` is what the user picks; `detail`
 *  is the one-line "what this means" the user reads before choosing. */
export interface AskOption {
  label: string;
  detail?: string;
}

/** An explained multiple-choice. The click on an option is the answer AND, when
 *  the option carries a cost, the cost approval (per the in-app-approval rule). */
export interface AskBlock {
  question?: string;
  options: AskOption[];
  /** Whether to offer a free-text "other" answer. Defaults to true — some
   *  answers (a name, an endpoint id, a sum) can't be enumerated as buttons. */
  allowOther?: boolean;
}

/** An editable list of steps: the user can delete / edit / add rows, then
 *  confirm the final list, which is sent back for Claude to execute. */
export interface PlanBlock {
  title?: string;
  steps: string[];
}

export type Segment =
  | { kind: "md"; text: string }
  | { kind: "ask"; block: AskBlock; raw: string }
  | { kind: "plan"; block: PlanBlock; raw: string };

/** Matches a fenced block whose info-string is `smrt-ask` or `smrt-plan`.
 *  The body is everything up to the closing fence on its own line. Tolerates
 *  trailing spaces after the info-string and an optional trailing newline
 *  before the closing fence. */
const BLOCK_RE = /```[ \t]*smrt-(ask|plan)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Validate + normalize an `smrt-ask` payload. Returns null on any shape
 *  mismatch so the caller can fall back to rendering the raw block. */
function parseAsk(body: string): AskBlock | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.options)) return null;
  const options: AskOption[] = [];
  for (const raw of obj.options) {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (!isNonEmptyString(o.label)) return null;
    options.push({
      label: o.label.trim(),
      detail: isNonEmptyString(o.detail) ? o.detail.trim() : undefined,
    });
  }
  if (options.length === 0) return null;
  return {
    question: isNonEmptyString(obj.question) ? obj.question.trim() : undefined,
    options,
    // Absent → allowed. Only an explicit `false` removes the escape hatch.
    allowOther: obj.allowOther !== false,
  };
}

/** Validate + normalize an `smrt-plan` payload. */
function parsePlan(body: string): PlanBlock | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) return null;
  const steps = obj.steps.filter(isNonEmptyString).map((s) => s.trim());
  if (steps.length === 0) return null;
  return {
    title: isNonEmptyString(obj.title) ? obj.title.trim() : undefined,
    steps,
  };
}

/**
 * Split an answer into ordered segments. Text between blocks (and any block
 * that fails to parse) becomes an `md` segment; a valid block becomes an
 * `ask`/`plan` segment carrying both the parsed data and its raw source.
 *
 * `hasInteractive(segments)` tells a caller whether the answer contains any real
 * widget, so a plain answer takes the untouched single-Markdown fast path.
 */
export function splitInteractive(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  // A fresh RegExp per call — BLOCK_RE is stateful (global flag) and reused.
  const re = new RegExp(BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  const pushMd = (s: string) => {
    if (s.length > 0) segments.push({ kind: "md", text: s });
  };
  while ((m = re.exec(text)) !== null) {
    const [whole, kind, body] = m;
    const parsed = kind === "ask" ? parseAsk(body) : parsePlan(body);
    if (!parsed) {
      // Malformed: leave it where it is, as raw text. It'll render as a code
      // block — nothing is lost, and the user still sees what Claude wrote.
      continue;
    }
    pushMd(text.slice(last, m.index));
    if (kind === "ask") {
      segments.push({ kind: "ask", block: parsed as AskBlock, raw: whole });
    } else {
      segments.push({ kind: "plan", block: parsed as PlanBlock, raw: whole });
    }
    last = m.index + whole.length;
  }
  pushMd(text.slice(last));
  return segments;
}

/** True when at least one segment is a real interactive widget. */
export function hasInteractive(segments: Segment[]): boolean {
  return segments.some((s) => s.kind !== "md");
}
