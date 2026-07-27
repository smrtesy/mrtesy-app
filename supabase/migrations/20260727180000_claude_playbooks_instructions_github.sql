-- Claude in the app — slice 2 of docs/claude-console/plan.md, specified in
-- docs/claude-console/app-integration-plan.md.
--
-- Three additions, all backend-only (service-role Express routes), matching the
-- claude_runs pattern: RLS enabled with NO permissive client policy.
--
--   claude_playbooks     — "שיטות עבודה": the working method a run follows. One row
--                          per method (kind + name), carrying the deep link to the
--                          document that defines it and the editable instruction
--                          body that gets prepended to the run's prompt.
--   claude_instructions  — one standing-instructions document per org, editable
--                          from the Claude screen, prepended to EVERY run.
--   claude_runs (+cols)  — which playbook a run used, what the human actually
--                          typed, and which GitHub repo/branch it worked on.
--
-- Additive: no existing column changes type, no existing flow is affected.

-- ── שיטות עבודה ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_playbooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The "type" shown as the row's headline in the list. A closed set so the list
  -- can group and label reliably; extend it in a migration, never ad-hoc.
  kind         text NOT NULL
                 CHECK (kind IN ('research', 'planning', 'build', 'review', 'content', 'other')),

  name         text NOT NULL,

  -- The deep link to the document that defines the method, emitted VERBATIM in
  -- the list and in the composed prompt (CLAUDE.md "preserve deep links"): a
  -- GitHub blob URL with its branch and path, never a bare domain.
  doc_url      text,
  -- Repo-relative path + repo, kept alongside doc_url so the GitHub refresh can
  -- ask for this exact file's last commit without re-parsing the URL.
  doc_path     text,
  repo         text,

  -- The body that is actually prepended to the run's prompt. Markdown, edited in
  -- place from the Claude screen — this is what makes the method operative rather
  -- than a link the user has to go read.
  instructions text,

  -- 'repo' = seeded from a document that lives in a repo (the link is canonical);
  -- 'db'   = written straight into the app.
  source       text NOT NULL DEFAULT 'db' CHECK (source IN ('db', 'repo')),

  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,

  -- "תאריך עדכון אחרון" as shown in the list: the document's own last-changed
  -- time (from GitHub for source='repo'), NOT this row's updated_at — those are
  -- different facts and conflating them would show the wrong date.
  doc_updated_at timestamptz,

  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One method per (org, kind, name): makes the idempotent seed an upsert
  -- instead of a duplicate-generator on every call.
  UNIQUE (org_id, kind, name)
);

CREATE INDEX IF NOT EXISTS idx_claude_playbooks_org
  ON claude_playbooks (org_id, is_active, sort_order);

ALTER TABLE claude_playbooks ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_playbooks IS
  'שיטות עבודה — the method a Claude run follows: type, name, verbatim deep link to '
  'its defining document, and the editable instruction body prepended to the prompt. '
  'Backend-only, RLS on with no client policy.';


-- ── הוראות קבועות ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_instructions (
  -- Exactly one document per org: the standing instructions every run inherits.
  org_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE claude_instructions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE claude_instructions IS
  'One standing-instructions document per org, prepended to every Claude run. '
  'Editable from the Claude screen. Backend-only, RLS on with no client policy.';


-- ── claude_runs — what the run was actually given ────────────────────────────

-- The method this run followed, so a run stays traceable to it after the
-- playbook text is edited. SET NULL rather than CASCADE: deleting a method must
-- never delete the history of runs that used it.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS playbook_id uuid REFERENCES claude_playbooks(id) ON DELETE SET NULL;

-- What the human typed, kept separately from `prompt` (which holds the fully
-- composed text: standing instructions + playbook + this). Without it the
-- original request would be unrecoverable from the composed blob.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS user_prompt text;

-- The branch the run was given, next to the existing `repo` column. The repo is
-- cloned into a temporary workspace by the runner; `cwd` records where.
ALTER TABLE claude_runs
  ADD COLUMN IF NOT EXISTS git_branch text;

COMMENT ON COLUMN claude_runs.user_prompt IS
  'What the human typed. `prompt` holds the composed text actually sent to the engine.';
