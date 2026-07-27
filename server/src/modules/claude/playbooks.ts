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
import { db } from "../../db";
import { fileLastCommitDate, blobUrl, getGitHubToken } from "./github";

const router = Router();

const KINDS = new Set(["research", "planning", "build", "review", "content", "other"]);
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

  const { data, error } = await db
    .from("claude_playbooks")
    .insert({
      org_id: req.org!.id,
      created_by: req.user!.id,
      kind,
      name,
      doc_url: docUrl,
      doc_path: str(body.doc_path, 500) || null,
      repo: str(body.repo, 200) || null,
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
  if (body.repo !== undefined) patch.repo = str(body.repo, 200) || null;
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
    .select("body, updated_at")
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (error) {
    console.error("[claude/instructions] fetch failed:", error.message);
    return res.status(500).json({ error: "could not load instructions" });
  }
  // An org that never saved one reads as empty, not 404 — the screen always has a
  // document to open.
  return res.json({ body: data?.body ?? "", updated_at: data?.updated_at ?? null });
});

router.put("/claude/instructions", async (req: Request, res: Response) => {
  const body = typeof req.body?.body === "string" ? req.body.body.slice(0, MAX_BODY) : "";

  const { data, error } = await db
    .from("claude_instructions")
    .upsert(
      {
        org_id: req.org!.id,
        body,
        updated_by: req.user!.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" },
    )
    .select("body, updated_at")
    .single();

  if (error) {
    console.error("[claude/instructions] save failed:", error.message);
    return res.status(500).json({ error: "could not save instructions" });
  }
  return res.json({ body: data.body, updated_at: data.updated_at });
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
