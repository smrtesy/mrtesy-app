/**
 * שיטות עבודה + הוראות קבועות — the two things that make a run follow OUR method
 * instead of starting from nothing (docs/claude-console/app-integration-plan.md).
 *
 *   claude_playbooks     one row per working method: type, name, the verbatim deep
 *                        link to the document that defines it, and the editable
 *                        instruction body prepended to the prompt.
 *   claude_instructions  one standing-instructions document per org, prepended to
 *                        EVERY run.
 *
 * Routes (mounted under the same requireSuperAdmin chain as the rest of the module):
 *   GET   /api/claude/playbooks            list
 *   POST  /api/claude/playbooks            create
 *   PATCH /api/claude/playbooks/:id        update (this is the "edit in place")
 *   DELETE /api/claude/playbooks/:id       remove
 *   POST  /api/claude/playbooks/seed       idempotent seed of the repo defaults
 *   POST  /api/claude/playbooks/refresh    refresh doc_updated_at from GitHub
 *   GET   /api/claude/instructions         read the standing document
 *   PUT   /api/claude/instructions         replace it
 *
 * composePrompt() is exported because the launch route — not the client — is what
 * assembles the final text. Composing on the client would let a caller silently
 * drop the standing instructions.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db, getAppSecret } from "../../db";
import { fileLastCommitDate, blobUrl, getGitHubToken, isValidRepo } from "./github";
import { BROWSER_HELPER_PATH } from "./app-access";

const router = Router();

const KINDS = new Set(["research", "planning", "build", "review", "content", "other"]);
// Mirrors threads.ts — the per-org defaults are validated by the same rules a
// per-thread model/effort is, so a stored default can never be a value the run
// launcher would then reject.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NAME = 200;
const MAX_URL = 1000;
const MAX_BODY = 60_000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only ever store an http(s) URL. A `javascript:`/`data:` value would become a live
 * link in the list, so it is rejected at the door rather than at render.
 *
 * Three-way on purpose: `null` = no URL given, `false` = a URL was given but is not
 * http(s). Coercing the second case to null silently discarded a link the user had
 * pasted (a scheme-less "github.com/…" is the common slip) and still answered
 * "saved" — so `false` becomes a 400 instead.
 */
function parseUrl(v: unknown): string | null | false {
  const s = str(v, MAX_URL);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : false;
}

const URL_ERROR = "doc_url must start with http:// or https://";

const SELECT =
  "id, kind, name, doc_url, doc_path, repo, instructions, source, is_active, sort_order, doc_updated_at, created_at, updated_at";

/**
 * The defaults, seeded once per org.
 *
 * Every entry points at a document that ALREADY exists in a repo — that is the
 * "combo" the user asked for: the row lives in the DB (so it is editable and
 * carries its own instruction body), and its canonical text stays the repo file
 * the deep link opens. `instructions` is intentionally a short operative summary,
 * not a copy of the document: copying 1400 lines into every prompt would bury the
 * actual task, and a stale copy is worse than a link.
 *
 * TENANT NOTE: the repos named here are smrtesy's own. That is safe because seeding
 * is an explicit button, org-scoped, and every row can be edited or deleted — but a
 * different tenant should add their own methods rather than seed these.
 */
const SEED: {
  kind: string;
  name: string;
  repo: string;
  doc_path: string;
  branch: string;
  sort_order: number;
  instructions: string;
}[] = [
  {
    kind: "research",
    name: "פרוטוקול מחקר דו-שלבי",
    repo: "smrtesy/mrtesy-app",
    doc_path: "docs/project-planning-protocol.md",
    branch: "main",
    sort_order: 10,
    instructions: [
      "עבוד לפי פרוטוקול המחקר הדו-שלבי שבמסמך המקושר. חובות:",
      "1. מחקר מונחה-החלטה: פתח בשאלת ההחלטה ובהשערת-עבודה במשפט אחד — לא באיסוף חומר.",
      "2. שני ערוצים: מקורות רשמיים **וגם** קהילה (רדיט/X/יוטיוב/דיסקורד). טריק קהילתי = השערה שנבדקת בזול.",
      "3. משפך → ספייק → בייק-אוף: צמצם אופציות, בדוק את המובילות, השווה בפועל.",
      "4. התוצר הוא **תזכיר החלטה** בעמוד אחד: ההמלצה בראש, אחריה מה נבדק, מה לא נבדק (גבולות המחקר), ומה עוד פתוח.",
      "5. כל טענה נושאת מקור. קישורים כלשונם — לינק עמוק מדויק, לא דומיין.",
      "6. אין hedge בתוצר גמור: מה שאפשר לאמת — מאמתים; מה שדורש הרצה — מסומן במפורש כ'נבדק אמפירית'.",
    ].join("\n"),
  },
  {
    kind: "planning",
    name: "פרוטוקול תכנון פרויקט",
    repo: "smrtesy/mrtesy-app",
    doc_path: "docs/project-planning-protocol.md",
    branch: "main",
    sort_order: 20,
    instructions: [
      "תכנן לפי הפרוטוקול שבמסמך המקושר. חובות:",
      "1. סווג קודם את הפרויקט בשני הצירים (היקף, ודרגת אי-ודאות מ0/מ1/מ2) והצג את הסיווג במשפט אחד.",
      "2. עבור תחנה-תחנה. אל תדלג על תחנה בלי לומר במפורש שהיא נשמטת ולמה.",
      "3. המתכנן לא מבצע את המחקר — הוא **מבנה** אותו כשרשרת משימות.",
      "4. התוצר: מסמך תוכנית ברפו (docs/*-plan.md) שנדחף לגיטהאב, ובסופו הקישור לקריאה.",
      "5. כל ❓ פתוח נרשם במרשם הטכני עם מי מכריע ומתי.",
    ].join("\n"),
  },
  {
    kind: "build",
    name: "פרוטוקול לפני-דחיפה",
    repo: "smrtesy/mrtesy-app",
    doc_path: "docs/pre-push-protocol.md",
    branch: "main",
    sort_order: 30,
    instructions: [
      "לפני כל דחיפה עבור את הרצף במלואו, בלי לבקש רשות:",
      "1. `npm install --no-audit --no-fund && npm run build` — הבדיקה הקובעת היחידה.",
      "2. הגרפים הממוקדים: ערכים קשיחים, אילוצי CHECK, ברירות-מחדל של API, אי-התאמה בין מחרוזת UI לפילטר, insert/update בלי `{ error }`.",
      "3. סקירת סוכן-משנה על הדיף המלא; כל ממצא HIGH/MED חוסם דחיפה.",
      "4. עדכון סטטוס האפליקציה אם נגעת בקבצים שלה.",
      "5. היגיינת קומיטים: בלי console.log, בלי TODO, בלי קבצי סוד.",
    ].join("\n"),
  },
  {
    kind: "research",
    name: "מחקר מודלים ל-fal (video-lab)",
    repo: "smrtesy/video-lab",
    doc_path: "docs/pipeline.md",
    branch: "main",
    sort_order: 40,
    instructions: [
      "עבוד לפי כללי הברזל של video-lab (המסמך המקושר). חובות:",
      "1. fal רק דרך התור האסינכרוני (`fal.queue.submit`) — אף פעם לא `fal.run` החוסם.",
      "2. אישור-עלות מפורש לפני כל הרצה בתשלום, עם הערכה לפריט ולסך.",
      "3. בחירת מודל לפי הסדר: ראיה חזקה להתאמה → מחיר → מהירות.",
      "4. **אין לנחש את החוזה:** כל endpoint וכל שדה קלט מאומת מול הסכמה הרשמית",
      "   `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` לפני נעילה.",
      "5. תוצרים יורדים לאחסון שלנו תוך כדי ההרצה (קישורי fal מתים אחרי 24 שעות).",
      "6. נכס נעול לא נוצר מחדש. ניקוד עיוור נשמר ל-DB.",
    ].join("\n"),
  },
  {
    kind: "review",
    name: "סקירת קוד לפני מיזוג",
    repo: "smrtesy/mrtesy-app",
    doc_path: "docs/pre-push-protocol.md",
    branch: "main",
    sort_order: 50,
    instructions: [
      "סקור את הדיף וקרא כל קובץ שהשתנה במלואו. לכל שינוי שאל:",
      "1. האם מחרוזת UI מבטיחה משהו שהבקאנד לא מספק?",
      "2. האם כתיבה ל-DB מפרה CHECK / NOT NULL / FK / unique? קרא את קובץ המיגרציה.",
      "3. האם קוד שהוסר (פילטר, fallback, ולידציה) משאיר את הסביבה שבורה בשקט?",
      "4. האם יש ערך קשיח שנשבר ללקוח אחר (folder id, אימייל, שם חשבון)?",
      "5. האם `await` על שאילתה בולע את `{ error }`?",
      "6. האם יש אי-סימטריה של חלון-זמן או off-by-one?",
      "לכל ממצא: file:line, מה נשבר ומתי, חומרה HIGH/MED/LOW, ותיקון בשורה אחת.",
    ].join("\n"),
  },
];

// ── שיטות עבודה ───────────────────────────────────────────────────────────────

router.get("/claude/playbooks", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("claude_playbooks")
    .select(SELECT)
    .eq("org_id", req.org!.id)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    console.error("[claude/playbooks] list failed:", error.message);
    return res.status(500).json({ error: "could not list playbooks" });
  }
  return res.json({ playbooks: data ?? [] });
});

router.post("/claude/playbooks", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const kind = str(body.kind, 32);
  const name = str(body.name, MAX_NAME);
  if (!KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(", ")}` });
  if (!name) return res.status(400).json({ error: "name is required" });

  const docUrl = parseUrl(body.doc_url);
  if (docUrl === false) return res.status(400).json({ error: URL_ERROR });

  // Validated on write, not just when a run uses it: the repo string flows into the
  // environment preamble (composePrompt), so a malformed value must never be stored.
  const repo = str(body.repo, 200) || null;
  if (repo && !isValidRepo(repo)) return res.status(400).json({ error: "repo must be owner/name" });

  const { data, error } = await db
    .from("claude_playbooks")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      kind,
      name,
      doc_url: docUrl,
      doc_path: str(body.doc_path, 500) || null,
      repo,
      instructions: str(body.instructions, MAX_BODY) || null,
      source: "db",
      sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100,
    })
    .select(SELECT)
    .single();

  if (error) {
    console.error("[claude/playbooks] insert failed:", error.message);
    // 23505 is unique_violation: the (org, kind, name) key already holds a method.
    if (error.code === "23505") return res.status(409).json({ error: "a playbook with this name already exists" });
    return res.status(500).json({ error: "could not create playbook" });
  }
  return res.status(201).json({ playbook: data });
});

router.patch("/claude/playbooks/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "playbook not found" });
  const body = req.body ?? {};

  // Built key-by-key so an absent field is left alone rather than nulled — the
  // editor sends only what the user changed.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.kind !== undefined) {
    const kind = str(body.kind, 32);
    if (!KINDS.has(kind)) return res.status(400).json({ error: "invalid kind" });
    patch.kind = kind;
  }
  if (body.name !== undefined) {
    const name = str(body.name, MAX_NAME);
    if (!name) return res.status(400).json({ error: "name cannot be empty" });
    patch.name = name;
  }
  if (body.doc_url !== undefined) {
    const docUrl = parseUrl(body.doc_url);
    if (docUrl === false) return res.status(400).json({ error: URL_ERROR });
    patch.doc_url = docUrl;
  }
  if (body.doc_path !== undefined) patch.doc_path = str(body.doc_path, 500) || null;
  if (body.repo !== undefined) {
    const repo = str(body.repo, 200) || null;
    if (repo && !isValidRepo(repo)) return res.status(400).json({ error: "repo must be owner/name" });
    patch.repo = repo;
  }
  if (body.instructions !== undefined) patch.instructions = str(body.instructions, MAX_BODY) || null;
  if (body.is_active !== undefined) patch.is_active = !!body.is_active;
  if (body.sort_order !== undefined && Number.isFinite(Number(body.sort_order))) {
    patch.sort_order = Number(body.sort_order);
  }

  const { data, error } = await db
    .from("claude_playbooks")
    .update(patch)
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .select(SELECT)
    .maybeSingle();

  if (error) {
    console.error("[claude/playbooks] update failed:", error.message);
    if (error.code === "23505") return res.status(409).json({ error: "a playbook with this name already exists" });
    return res.status(500).json({ error: "could not update playbook" });
  }
  if (!data) return res.status(404).json({ error: "playbook not found" });
  return res.json({ playbook: data });
});

router.delete("/claude/playbooks/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "playbook not found" });

  const { error } = await db
    .from("claude_playbooks")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id);

  if (error) {
    console.error("[claude/playbooks] delete failed:", error.message);
    return res.status(500).json({ error: "could not delete playbook" });
  }
  return res.json({ ok: true });
});

/**
 * Seed the repo defaults for this org — idempotent.
 *
 * onConflict on (org_id, kind, name) with ignoreDuplicates so a second call adds
 * nothing and, crucially, does NOT overwrite an instruction body the user has
 * since edited. The seed is a starting point, not a source of truth that keeps
 * reasserting itself.
 */
router.post("/claude/playbooks/seed", async (req: Request, res: Response) => {
  const rows = SEED.map((s) => ({
    org_id: req.org!.id,
    created_by: req.user!.id,
    kind: s.kind,
    name: s.name,
    repo: s.repo,
    doc_path: s.doc_path,
    doc_url: blobUrl(s.repo, s.branch, s.doc_path),
    instructions: s.instructions,
    source: "repo",
    sort_order: s.sort_order,
  }));

  const { data, error } = await db
    .from("claude_playbooks")
    .upsert(rows, { onConflict: "org_id,kind,name", ignoreDuplicates: true })
    .select("id");

  if (error) {
    console.error("[claude/playbooks] seed failed:", error.message);
    return res.status(500).json({ error: "could not seed playbooks" });
  }
  return res.json({ inserted: data?.length ?? 0 });
});

/**
 * Refresh each repo-backed method's "last updated" from GitHub.
 *
 * The date shown in the list is the DOCUMENT's last change, so it has to come
 * from the commit that touched that file — not from this row's updated_at, which
 * only says when someone edited the app copy. Without a GitHub token this answers
 * 400 rather than silently leaving the dates stale.
 */
router.post("/claude/playbooks/refresh", async (req: Request, res: Response) => {
  // Checked once up front rather than per row: without a token every row would
  // fail identically, and the caller would get a list of N copies of the same
  // message instead of the one fact that matters.
  if (!(await getGitHubToken())) {
    return res.status(400).json({
      error:
        "GITHUB_TOKEN is not configured, so document dates cannot be refreshed. " +
        "Save a GitHub token with 'repo' scope under /admin/apps/smrttask/secrets.",
    });
  }

  const { data: rows, error } = await db
    .from("claude_playbooks")
    .select("id, repo, doc_path")
    .eq("org_id", req.org!.id)
    .eq("source", "repo")
    .not("repo", "is", null)
    .not("doc_path", "is", null);

  if (error) {
    console.error("[claude/playbooks] refresh list failed:", error.message);
    return res.status(500).json({ error: "could not load playbooks" });
  }

  let updated = 0;
  const failures: string[] = [];
  for (const row of rows ?? []) {
    try {
      const date = await fileLastCommitDate(row.repo!, row.doc_path!);
      if (!date) continue;
      const { error: upErr } = await db
        .from("claude_playbooks")
        .update({ doc_updated_at: date, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (upErr) {
        failures.push(`${row.repo}/${row.doc_path}: ${upErr.message}`);
        continue;
      }
      updated += 1;
    } catch (e) {
      failures.push(`${row.repo}/${row.doc_path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Reported rather than thrown: one unreachable repo must not discard the dates
  // that did refresh, and the caller needs to know which ones didn't.
  return res.json({ updated, failures });
});

// ── הוראות קבועות ─────────────────────────────────────────────────────────────

router.get("/claude/instructions", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("claude_instructions")
    .select("body, default_model, default_effort, updated_at")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) {
    console.error("[claude/instructions] fetch failed:", error.message);
    return res.status(500).json({ error: "could not load instructions" });
  }
  // An org that never saved one reads as empty, not 404 — the screen always has a
  // document to open. Defaults are null until the operator picks them (the client
  // then falls back to the app's built-in default).
  return res.json({
    body: data?.body ?? "",
    default_model: data?.default_model ?? null,
    default_effort: data?.default_effort ?? null,
    updated_at: data?.updated_at ?? null,
  });
});

router.put("/claude/instructions", async (req: Request, res: Response) => {
  const b = req.body ?? {};

  // Partial: only the fields present in the request change. The screen has two
  // independent writers on this one-row-per-org table — the standing-instructions
  // textarea and the default model/effort selects — so a save of one must never
  // blank the other.
  let bodyText: string | undefined;
  if (b.body !== undefined) bodyText = typeof b.body === "string" ? b.body.slice(0, MAX_BODY) : "";

  let defaultModel: string | null | undefined;
  if (b.default_model !== undefined) {
    const m = str(b.default_model, 64);
    if (m && !MODEL_RE.test(m)) return res.status(400).json({ error: "invalid default_model" });
    defaultModel = m || null; // "" clears back to the app default
  }

  let defaultEffort: string | null | undefined;
  if (b.default_effort !== undefined) {
    const e = str(b.default_effort, 16);
    if (e && !EFFORTS.has(e)) return res.status(400).json({ error: "invalid default_effort" });
    defaultEffort = e || null; // "" clears back to engine-chosen
  }

  // Read-modify-write so a partial patch upserts a COMPLETE row: an org's
  // first-ever save (e.g. only default_model) must still write the NOT NULL body
  // default, and each field carried forward keeps the others intact.
  const { data: existing, error: readErr } = await db
    .from("claude_instructions")
    .select("body, default_model, default_effort")
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (readErr) {
    console.error("[claude/instructions] read-before-save failed:", readErr.message);
    return res.status(500).json({ error: "could not save instructions" });
  }

  const row = {
    org_id: req.org!.id,
    body: (bodyText !== undefined ? bodyText : existing?.body) ?? "",
    default_model: (defaultModel !== undefined ? defaultModel : existing?.default_model) ?? null,
    default_effort: (defaultEffort !== undefined ? defaultEffort : existing?.default_effort) ?? null,
    updated_by: req.user!.id,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("claude_instructions")
    .upsert(row, { onConflict: "org_id" })
    .select("body, default_model, default_effort, updated_at")
    .single();

  if (error) {
    console.error("[claude/instructions] save failed:", error.message);
    return res.status(500).json({ error: "could not save instructions" });
  }
  return res.json({
    body: data.body,
    default_model: data.default_model,
    default_effort: data.default_effort,
    updated_at: data.updated_at,
  });
});

// ── prompt composition ────────────────────────────────────────────────────────

export interface ComposedPrompt {
  prompt: string;
  playbook: { id: string; kind: string; name: string; doc_url: string | null } | null;
}

/**
 * Byte budget for the composed prompt.
 *
 * The runner passes it as a single argv entry, and Linux caps one argument at
 * MAX_ARG_STRLEN (131 072 bytes). Hebrew is 2 bytes per character in UTF-8, so the
 * field limits alone (60k + 60k + 20k chars) could produce ~280 KB and the run would
 * die as an opaque `spawn E2BIG`. 100 KB leaves clear headroom.
 */
const MAX_COMPOSED_BYTES = 100_000;
const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

/** Trim to a byte budget on a character boundary, with a visible marker so a
 *  truncated instruction never reads as a complete one. */
function clampBytes(text: string, budget: number): string {
  if (byteLen(text) <= budget) return text;
  const marker = "\n…[נחתך]";
  // Budget too small to hold even the marker: return nothing, so the result is
  // always within budget rather than the marker alone overflowing it.
  if (budget <= byteLen(marker)) return "";
  let end = Math.max(0, budget - byteLen(marker));
  // Walk back until the slice fits: a multi-byte character straddling the cut would
  // otherwise push it back over the budget.
  let out = text.slice(0, end);
  while (byteLen(out) > budget - byteLen(marker) && end > 0) {
    end -= 1;
    out = text.slice(0, end);
  }
  return out + marker;
}

/**
 * Build the text actually handed to the engine: standing instructions, then the
 * chosen method (with its deep link emitted verbatim so the run can open the
 * defining document itself), then what the human asked for.
 *
 * Returns `playbook: null` when the id doesn't resolve for this org — the caller
 * decides whether that is an error. It never silently falls back to a different
 * method, because running the wrong protocol is worse than running none.
 */
export async function composePrompt(
  orgId: string,
  userPrompt: string,
  playbookId: string | null,
): Promise<ComposedPrompt> {
  const parts: string[] = [];

  // The task itself is never trimmed — only the two context sections are, and they
  // split whatever budget the task leaves. Truncating what the user actually asked
  // for to make room for boilerplate would be the wrong way round.
  const taskBytes = byteLen(userPrompt);
  const contextBudget = Math.max(0, MAX_COMPOSED_BYTES - taskBytes - 200);

  // ── environment preamble ──────────────────────────────────────────────────
  // Grounding the run in WHERE it lives. Without this the engine wakes in an empty
  // temp directory with no idea it is inside smrtesy or that it can reach GitHub —
  // so it tells the user "I have no repo access", which is false: a token IS
  // configured and the run carries git credentials. Short and fixed (not subject to
  // the context trim), because it is orientation the whole conversation needs.
  //
  // The repo NAMES come from this org's own playbooks (org-scoped DB), never a
  // hardcoded list — so it stays correct per tenant. isValidRepo filters any
  // malformed value so only real owner/name strings reach the prompt.
  const { data: repoRows, error: rErr } = await db
    .from("claude_playbooks")
    .select("repo")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .not("repo", "is", null);
  if (rErr) console.error("[claude/compose] repo list fetch failed:", rErr.message);
  const orgRepos = Array.from(
    new Set((repoRows ?? []).map((r) => (r.repo ?? "").trim()).filter((v) => v && isValidRepo(v))),
  );

  // Whether GitHub access is REALLY available decides what the preamble may claim.
  // Telling the model "you can clone any repo" when no token is set is the exact
  // inverse of the bug this fixes — it would confidently promise access it lacks.
  const hasGitHub = Boolean(await getGitHubToken());

  // Whether the destructive-migration approval gate is actually reachable from a run.
  // Same env the runner injects into the child (runner.ts): without both the internal
  // secret and the backend URL, the m2m endpoint can't be called, so the preamble must
  // NOT tell the run to use it — it should fall back to asking the human instead.
  const gateReachable = Boolean(
    (process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET) &&
      (process.env.SMRTESY_PUBLIC_URL || process.env.SMRTESY_BACKEND_URL),
  );

  // Whether a run can actually APPLY a migration. The apply goes through the Supabase
  // Management API query endpoint (see runner.ts), which needs only the access token —
  // the runner injects it (from app_secrets, smrttask slug) ONLY when it exists. Mirror
  // that exact condition here so the preamble never tells a run to "apply it yourself"
  // when there is no token to apply with — the same honesty rule as gateReachable and
  // hasGitHub. Read from the same store/key the runner reads, so the two can't drift.
  const supaToken = await getAppSecret("smrttask", "SUPABASE_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN");
  const migrationsReachable = Boolean(supaToken?.trim());

  const envLines = [
    "# איפה אתה רץ",
    "",
    "אתה קלוד, ורץ **בתוך פלטפורמת smrtesy** — בסביבת ה-backend שלה, לא על מחשב המשתמש. " +
      "זו הסביבה שבה צוות smrtesy עובד מול הפלטפורמה עצמה, והמקום הטבעי שמדברים איתך עליה.",
    "",
  ];
  if (hasGitHub) {
    envLines.push(
      "- **הריפו כבר אצלך:** אם מחובר ריפו לצ'אט הזה (וכברירת מחדל מחובר הריפו הראשי), " +
        "**המערכת כבר שכפלה אותו לתיקיית העבודה שלך** — אתה יכול לקרוא ולערוך את הקבצים ישירות, בלי פעולה מקדימה.",
      "- **יש לך מעטפת (shell) מלאה בתוך העותק הזה** — git, npm, בדיקות, בנייה, דחיפה, ו-`curl`. " +
        "אתה עובד כמו מפתח בצוות: קורא, עורך, מריץ ומוסר. אל תאמר למשתמש שאין לך גישה להרצת פקודות — יש.",
      "- כדי לעבוד על ריפו **אחר**, בקש מהמשתמש לבחור אותו בהגדרות הצ'אט (כפתור ההגדרות ← בחירת ריפו), " +
        "והמערכת תשכפל אותו עבורך בתור הבא. אל תבקש מהמשתמש כתובת או טוקן — ההרשאה כבר בסביבה.",
    );
    if (orgRepos.length > 0) {
      envLines.push(`- **הריפו-ים של הארגון:** ${orgRepos.join(", ")}.`);
    }
    // The autonomy protocol — the operational half of docs/claude-console/
    // autonomy-safety-gate.md, stated where the run will actually read it. The rule
    // in one line: reversible → do it yourself; irreversible → route through a human.
    // The first bullet (from origin/main) is repo orientation; the rest is the gate.
    envLines.push(
      "- **התמצאות מהירה בריפו:** לפני שאתה חוקר עץ קבצים, קרא בשורש הריפו את `CLAUDE.md` ואת " +
        'מפת הקודבייס `docs/codebase-map.md` (אם קיימת) — "איפה X" כמעט תמיד נענה משם. ' +
        "בריפו המחובר לצ'אט ה-CLAUDE.md כבר נטען אוטומטית — והמפה איתו, כשהיא קיימת.",
      "",
      "## מה מותר לך לעשות לבד (ומה לא)",
      "הכלל: **פעולה הפיכה — עשה לבד; פעולה בלתי-הפיכה — עצור לאישור אנושי.**",
      "- **סיום שינוי → הבאה ל-main (הפיך, לבד):** כשסיימת שינוי שאמור לעלות לאוויר, הרץ קודם את " +
        "פרוטוקול לפני-הדחיפה (`npm install --no-audit --no-fund && npm run build`, ותקן כל שגיאה חדשה בקבצים שנגעת בהם), " +
        "ואז מזג ל-main עם `--no-ff` כך ש-main מקבל commit משלו (לא fast-forward), ודחוף. " +
        "אל תבקש אישור למיזוג עצמו — הבנייה שעברה היא השער, ודחיפה הפיכה (revert / חזרה לגרסה ב-Vercel).",
      "  **אחרי הדחיפה — אל תנטר ואל תבטיח לנטר.** אחרי שהתור נגמר אתה נעצר, אז " +
        '"אני מנטר / אעדכן כשזה יעלה" היא הבטחה ריקה — ולולאת `curl` על `deploy-info` מיותרת. ' +
        "נקודת-הפריסה של הסשן ברשימה עושה את הניטור לבדה (תהליך-רקע, בלי טוקנים): היא נצבעת " +
        "**ירוק** כשהפריסה מאומתת חיה בפרודקשן, **אדום** אם הבנייה נכשלה, ו**שעון-חול צהוב** בזמן שהיא " +
        "בונה/ממתינה למיזוג. אל תריץ בדיקת-פריסה ואל תאמר שתבדוק — אמור למשתמש לעקוב אחרי נקודת-הפריסה " +
        "בשורת הסשן, וסיים את התור.",
      migrationsReachable
        ? "- **מיגרציה תוספתית/הפיכה** (ADD COLUMN, CREATE TABLE, CREATE INDEX, ADD CONSTRAINT, COMMENT): " +
          "**החל בעצמך** — כתוב את קובץ המיגרציה תחת `supabase/migrations/` (שם `YYYYMMDDHHMMSS_<slug>.sql`), " +
          "ואז החל **רק את ה-SQL של הקובץ הזה** על הפרודקשן דרך ה-Management API של Supabase:\n" +
          "  ```\n" +
          "  curl -sS -X POST \"https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_ID/database/query\" \\\n" +
          "    -H \"Authorization: Bearer $SUPABASE_ACCESS_TOKEN\" -H \"content-type: application/json\" \\\n" +
          "    --data-binary @- <<'JSON'\n" +
          "  {\"query\": <ה-SQL המלא של הקובץ, כמחרוזת JSON חוקית>}\n" +
          "  JSON\n" +
          "  ```\n" +
          "  `SUPABASE_ACCESS_TOKEN` ו-`SUPABASE_PROJECT_ID` כבר מוזרקים לך — אל תבקש אותם מהמשתמש. " +
          "⚠️ **לעולם אל תריץ `supabase db push`** ואל תריץ מיגרציות ישנות: היסטוריית המיגרציות המרוחקת של הריפו " +
          "מנוהלת בנפרד (דרך ה-Management API), ו-`db push` היה מריץ מחדש מאות מיגרציות ישנות. החל תמיד **קובץ בודד** — " +
          "רק זה שכתבת עכשיו. אם ה-API מחזיר שגיאה, דווח אותה למשתמש; אל תתקן את ה-DB ידנית."
        : "- **מיגרציה תוספתית/הפיכה** (ADD COLUMN, CREATE TABLE, CREATE INDEX, ADD CONSTRAINT, COMMENT): " +
          "כתוב את קובץ המיגרציה תחת `supabase/migrations/`, אבל **אינך יכול להחיל אותה** — הסוד " +
          "`SUPABASE_ACCESS_TOKEN` אינו מוגדר תחת /admin/apps/smrttask/secrets. " +
          "אמור למשתמש להוסיף אותו שם, או להחיל את הקובץ ידנית.",
      gateReachable
        ? "- **מיגרציה הרסנית** (DROP, DELETE, UPDATE שמשנה נתונים, TRUNCATE, ALTER COLUMN TYPE/SET NOT NULL): " +
          "**אל תחיל בעצמך.** קודם הרץ `SELECT` שקול כדי לראות מה ייפגע (ספירה + דגימה), ואז פתח כרטיס-אישור אנושי:\n" +
          "  ```\n" +
          "  curl -sS -X POST \"$SMRTESY_BACKEND_URL/api/claude-action/request-approval\" \\\n" +
          "    -H \"content-type: application/json\" -H \"x-cron-secret: $SMRTBOT_INTERNAL_SECRET\" \\\n" +
          "    -d '{\"org_id\":\"'\"$CLAUDE_ORG_ID\"'\",\"run_id\":\"'\"$CLAUDE_RUN_ID\"'\",\"repo\":\"<owner/name>\",\"git_branch\":\"<branch>\",\"migration_path\":\"supabase/migrations/<file>.sql\",\"sql\":\"<ה-SQL המלא>\",\"affected_count\":<מספר>,\"sample_rows\":[…]}'\n" +
          "  ```\n" +
          "  ה-backend מסווג את ה-SQL בעצמו: אם יתברר תוספתי תקבל `\"decision\":\"additive\"` (החל בעצמך); אם הרסני " +
          "תקבל `\"decision\":\"needs_approval\"` — **עצור ואמור למשתמש שהמיגרציה ממתינה לאישורו במסך האישורים.** " +
          "אחרי שיאשר, המערכת תריץ את ההחלה אוטומטית. אל תעקוף את זה ואל תמחק/תשנה נתונים ידנית."
        : "- **מיגרציה הרסנית** (DROP, DELETE, UPDATE שמשנה נתונים, TRUNCATE): **אל תחיל בעצמך ואל תמחק נתונים.** " +
          "שער-האישור אינו מוגדר בסביבה הזו (חסר SMRTBOT_INTERNAL_SECRET או SMRTESY_BACKEND_URL) — כתוב את קובץ המיגרציה, " +
          "ובקש מהמשתמש להריץ אותו ידנית ב-Supabase CLI אחרי שבדק אותו.",
    );
  } else {
    // No token: say so plainly and point at where to set it, instead of promising
    // access. This is the honest state, and it tells the user how to enable it.
    envLines.push(
      "- **גישה ל-GitHub לא מוגדרת עדיין.** כדי לאפשר לך לעבוד על ריפו-ים, יש לשמור טוקן GitHub " +
        "עם הרשאת repo תחת /admin/apps/smrttask/secrets (מפתח GITHUB_TOKEN). עד אז אין לך גישה לקוד.",
    );
  }
  envLines.push(
    "- תיקיית העבודה שלך נשמרת לאורך כל השיחה — לכן קובץ ששכפלת או ערכת בתור אחד קיים בתור הבא.",
  );
  if (gateReachable) {
    // The thread's short human code (K7) — injected as CLAUDE_THREAD_CODE by the
    // runner under the same condition (internal secret + backend url). Teaches the
    // session to state its own id and to resolve a code another session hands it.
    envLines.push(
      "- **מזהה הסשן הזה (ה-code הקצר):** המזהה הקצר של הצ'אט הזה נמצא במשתנה-הסביבה " +
        "`$CLAUDE_THREAD_CODE` (למשל `K7`) — זה מה שמוסרים בין סשנים כדי להצביע על צ'אט מסוים. " +
        'כשמבקשים ממך "מה ה-ID שלך" הרץ `echo $CLAUDE_THREAD_CODE` וענה את הערך. כדי לזהות צ\'אט אחר ' +
        "שנמסר לך ב-code כזה (למשל `K7`), פנה ל-" +
        "`GET $SMRTESY_API_URL/api/claude/threads/by-code/<code>` (עם ה-Authorization וה-X-Org-Id הרגילים) — " +
        "הוא מחזיר את ה-thread ואת ה-UUID שלו כדי שתוכל להמשיך לקרוא אותו.",
    );
  }

  // App API access — whether the run will actually carry a token is decided at
  // spawn time (runner.ts mints one per turn, best-effort), so the instruction is
  // phrased against the environment variables themselves: present means usable.
  envLines.push(
    "",
    "## גישה לאפליקציה עצמה (שימוש רגיל, כמו משתמש)",
    "",
    "- אם מוגדרים בסביבה `SMRTESY_API_URL` + `SMRTESY_API_TOKEN` (בדוק עם `env | grep SMRTESY`), " +
      "יש לך סשן אמיתי וקצר-מועד של המשתמש שפתח את הצ'אט. אתה יכול לקרוא ל-API של הפלטפורמה " +
      "בדיוק כמו שהפרונטאנד קורא לו:",
    "  `curl -sS \"$SMRTESY_API_URL/api/<route>\" -H \"Authorization: Bearer $SMRTESY_API_TOKEN\" -H \"X-Org-Id: $SMRTESY_ORG_ID\"`",
    "- זה מיועד לבדיקה אמיתית של התנהגות: לקרוא נתונים, להריץ פעולה, ולראות מה באמת חוזר — " +
      "במקום להסיק מהקוד בלבד. הטוקן מתחדש בכל תור, אז הוא תמיד בתוקף בזמן שאתה רץ.",
    "- זהירות: הקריאות פועלות על נתוני אמת של המשתמש. פעולות קריאה — חופשי; פעולות שכותבות או " +
      "מוחקות — רק אם המשתמש ביקש זאת במפורש בצ'אט.",
    "",
    "## דפדפן אמיתי על האפליקציה (לראות מסכים כמו המשתמש)",
    "",
    "- אם מוגדר `SMRTESY_APP_URL` בסביבה, יש לך דפדפן Chrome ללא-ראש שכבר **מחובר לאפליקציה " +
      "כמשתמש שפתח את הצ'אט**. שלוש פקודות (זו פקודת המעטפת היחידה שמאושרת לך מראש — הרץ אותה " +
      "**בדיוק בצורה הזו**, עם הנתיב המלא, כי האישור מותאם לטקסט הפקודה המילולי):",
    `  - \`node ${BROWSER_HELPER_PATH} shot <נתיב-במערכת> --out shot.png --attach\` — פותח מסך ומצלם; ` +
      "`--attach` שולח את הצילום לצ'אט כך שהמשתמש רואה אותו בתשובה שלך. נתיב יחסי (כמו `/he/tasks`) נפתח על האפליקציה.",
    `  - \`node ${BROWSER_HELPER_PATH} text <נתיב> --selector <css>\` — מדפיס את הטקסט המרונדר של מסך או רכיב.`,
    `  - \`node ${BROWSER_HELPER_PATH} run <script.mjs>\` — שליטה מלאה ב-Playwright: כתוב סקריפט עם ` +
      "`export default async ({ page, goto, shot, log }) => { … }` והרץ אותו (אין לייבא playwright — הוא מגיע מוזרק). " +
      "כתיבת הסקריפט דורשת הרשאת עריכה, שקיימת רק בצ'אט שמחובר לריפו.",
    "- כל פקודה מדווחת בסופה גם את שגיאות הקונסול של הדפדפן ואת ה-URL הסופי — קרא אותם; הם חלק מהראיה.",
    "- מתי להשתמש: לוודא שתיקון UI באמת נראה נכון, לראות מה המשתמש רואה כשהוא מדווח על בעיה, " +
      "ולצרף צילום כהוכחה במקום לתאר במילים. אחרי תיקון קוד — עדיף לצלם את המסך הפרוס רק אם התיקון כבר נפרס; " +
      "ציין ליד הצילום איזו גרסה הוא משקף.",
    "- אותם כללי זהירות כמו ה-API: לנווט, לקרוא ולצלם — חופשי; ללחוץ על פעולות שכותבות או מוחקות " +
      "נתונים — רק אם המשתמש ביקש זאת במפורש.",
    "",
    "## כשהמשתמש מסמן מקום באפליקציה",
    "",
    "- למשתמש יש 'מצב סימון': הוא לוחץ על רכיב במסך, וההודעה שתקבל תכיל את הנתיב (route), " +
      "תיאור הרכיב (תגית, מחלקות CSS, טקסט) ושרשרת האבות שלו.",
    "- כשמגיעה הודעה כזו: שכפל את ריפו האפליקציה (אם לא משוכפל), אתר את הקומפוננטה לפי " +
      "הטקסט/המחלקות/הנתיב (חיפוש בקוד — המסכים תחת `src/app` והקומפוננטות תחת `src/components`), " +
      "הבן מה קורה שם, ותקן או הסבר לפי מה שהמשתמש ביקש.",
    "- הנתיב שבהודעת הסימון עובד ישירות בדפדפן: `shot <הנתיב> --attach` מראה לך (ולמשתמש) " +
      "את המסך המדובר בפועל.",
  );

  // Interactive on-screen blocks — the console renders two reserved fenced
  // blocks as live widgets (src/components/claude/interactive/): an editable
  // plan and an explained multiple-choice. Emitting one lets the user CLICK
  // instead of typing; the click comes back as the next message. This is
  // orientation the model needs on turn one, so it lives in the preamble.
  envLines.push(
    "",
    "## בלוקים אינטראקטיביים על המסך (לחיצה במקום הקלדה)",
    "",
    "יש לך שני בלוקים מיוחדים שהקונסולה מרנדרת ככלי אינטראקטיבי במקום כטקסט. השתמש בהם כשהם " +
      "חוסכים למשתמש הקלדה — הוא לוחץ, והבחירה/התוכנית חוזרת אליך כהודעה הבאה. **הגוף חייב להיות " +
      "JSON תקין**, ועטוף בדיוק בגדר בשם המצוין (אחרת זה יוצג כטקסט רגיל).",
    "",
    "**בחירה מוסברת** — כשיש החלטה עם מספר קטן של אפשרויות ידועות. כל אפשרות נושאת שורת הסבר " +
      "אחת (`detail`): מה המשמעות, וכולל **מחיר** אם הפעולה בתשלום. לחיצת המשתמש היא גם התשובה " +
      "**וגם אישור-העלות** (כלל האישור-ב-UI: מחיר גלוי בנקודת הפעולה → הקליק הוא האישור). השאר " +
      "`allowOther` דלוק (ברירת המחדל) אלא אם באמת אין תשובה פתוחה אפשרית:",
    "```smrt-ask",
    '{ "question": "איזה מודל תמונות?",',
    '  "options": [',
    '    { "label": "flux-pro", "detail": "הכי איכותי, נאמן לדמות · ~$0.05 לתמונה · איטי יותר" },',
    '    { "label": "flux-schnell", "detail": "מהיר וזול · ~$0.003 לתמונה · פחות מדויק" }',
    '  ], "allowOther": true }',
    "```",
    "",
    "**תוכנית עריכה** — כשאתה מציע תוכנית רב-שלבית שהמשתמש אמור לאשר/לעצב. הוא מוחק/עורך/מוסיף " +
      "שורות ואז מאשר; **התוכנית שערך** (לא המקורית) חוזרת אליך לביצוע שלב-אחר-שלב. אל תתחיל לבצע " +
      "לפני שהאישור חזר:",
    "```smrt-plan",
    '{ "title": "תוכנית הפקת השוט",',
    '  "steps": ["יצירת דף דמות", "יצירת רקע", "הרכבת השוט", "ליפסינק"] }',
    "```",
    "",
    "**מתי לא להשתמש:** תשובה פתוחה שאי-אפשר למנות ככפתורים (שם, תסריט, קישור, סכום מדויק) — " +
      "שאל בטקסט רגיל, או הישען על `allowOther` בבלוק בחירה. אל תשים בלוק אינטראקטיבי סתם; רק כשהוא " +
      "באמת חוסך הקלדה בנקודת החלטה.",
    "**שני דגשים:** (1) **בלוק אינטראקטיבי אחד לתשובה** — ברגע שהמשתמש עונה על בלוק נפתח תור חדש " +
      "וכל הבלוקים באותה תשובה הופכים לקריאה-בלבד, אז אל תשים שני בלוקים שמצפים למענה באותה הודעה. " +
      "(2) **בלי שלושה גרשיים בתוך ה-JSON** (בערכי `detail`/`question`/`steps`) — הם סוגרים את הגדר מוקדם.",
  );

  parts.push(envLines.join("\n"));

  const { data: standing, error: sErr } = await db
    .from("claude_instructions")
    .select("body")
    .eq("org_id", orgId)
    .maybeSingle();
  if (sErr) console.error("[claude/compose] instructions fetch failed:", sErr.message);
  if (standing?.body?.trim()) {
    parts.push(
      `# הוראות קבועות\n\n${clampBytes(standing.body.trim(), Math.floor(contextBudget / 2))}`,
    );
  }

  let playbook: ComposedPrompt["playbook"] = null;
  if (playbookId) {
    const { data, error } = await db
      .from("claude_playbooks")
      .select("id, kind, name, doc_url, instructions")
      .eq("id", playbookId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) console.error("[claude/compose] playbook fetch failed:", error.message);
    if (data) {
      playbook = { id: data.id, kind: data.kind, name: data.name, doc_url: data.doc_url };
      const head = `# שיטת עבודה: ${data.name}`;
      // The link is emitted verbatim and BEFORE the body, so it survives a trim —
      // a truncated method still tells the run where to read the whole thing.
      const link = data.doc_url ? `\n\nהמסמך המלא: ${data.doc_url}` : "";
      const bodyText = data.instructions?.trim()
        ? `\n\n${clampBytes(data.instructions.trim(), Math.floor(contextBudget / 2))}`
        : "";
      parts.push(`${head}${link}${bodyText}`);
    }
  }

  parts.push(`# המשימה\n\n${userPrompt}`);
  return { prompt: parts.join("\n\n---\n\n"), playbook };
}

export default router;
