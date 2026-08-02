-- Google Drive catalog — a full, resumable inventory of a shared Drive subtree,
-- built by the built-in Claude via the Google Drive connector (zero paid API).
--
-- Design goals:
--   * One row per Drive node (folder OR file) under a scan root.
--   * Resumable BFS: `folder_expanded` marks folders whose children were already
--     listed, so a scan interrupted by context/token limits resumes from the DB
--     (query unexpanded folders) without re-listing anything.
--   * Phase-2 ready: summary / tags / decisions / content_indexed for the later
--     content-enrichment pass over text-bearing documents.

CREATE TABLE IF NOT EXISTS public.drive_catalog (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid        NOT NULL,
  root_folder_id  text        NOT NULL,          -- the scan root this row belongs to
  file_id         text        NOT NULL,          -- Drive file/folder id
  parent_id       text,                          -- Drive parent id (null for the root)
  title           text,
  mime_type       text,
  is_folder       boolean     NOT NULL DEFAULT false,
  kind            text,                           -- folder|document|spreadsheet|presentation|pdf|image|video|audio|archive|shortcut|other
  path            text,                           -- human-readable folder path, e.g. "Maor NEW/Documents/Bills"
  depth           integer,
  owner           text,
  file_size       bigint,
  file_extension  text,
  created_time    timestamptz,
  modified_time   timestamptz,
  view_url        text,
  -- Resumable-scan bookkeeping (folders only)
  folder_expanded boolean     NOT NULL DEFAULT false,
  -- Phase 2 — content enrichment (text-bearing docs)
  summary         text,
  tags            text[],
  decisions       text,
  content_indexed boolean     NOT NULL DEFAULT false,
  scanned_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_catalog_root_file_uniq UNIQUE (root_folder_id, file_id)
);

-- Resume query: "give me folders under this root that still need expanding".
CREATE INDEX IF NOT EXISTS drive_catalog_unexpanded_idx
  ON public.drive_catalog (root_folder_id, is_folder, folder_expanded)
  WHERE is_folder = true AND folder_expanded = false;

-- Tree walks and per-folder listings.
CREATE INDEX IF NOT EXISTS drive_catalog_parent_idx
  ON public.drive_catalog (root_folder_id, parent_id);

-- Owner-scoped browsing.
CREATE INDEX IF NOT EXISTS drive_catalog_user_idx
  ON public.drive_catalog (user_id, root_folder_id);

-- Content-enrichment queue: text docs not yet summarized.
CREATE INDEX IF NOT EXISTS drive_catalog_enrich_idx
  ON public.drive_catalog (root_folder_id, content_indexed)
  WHERE is_folder = false AND content_indexed = false;

-- Per-scan state / progress, so a resume knows the root and phase at a glance.
CREATE TABLE IF NOT EXISTS public.drive_catalog_scans (
  root_folder_id  text        PRIMARY KEY,
  user_id         uuid        NOT NULL,
  root_title      text,
  status          text        NOT NULL DEFAULT 'inventory',  -- inventory|inventory_done|enriching|done
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Private data: deny by default at the row level. The backend/service role
-- bypasses RLS; a signed-in owner may read their own catalog rows.
ALTER TABLE public.drive_catalog       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_catalog_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY drive_catalog_owner_select
  ON public.drive_catalog FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY drive_catalog_scans_owner_select
  ON public.drive_catalog_scans FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.drive_catalog IS
  'Resumable inventory of a Google Drive subtree, cataloged by the built-in Claude via the Drive connector. One row per folder/file under root_folder_id.';
