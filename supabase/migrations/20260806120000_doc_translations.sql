-- Bilingual docs tab — on-demand translations of repo docs/**.md.
-- Design: docs/bilingual-docs-plan.md.
--
-- A repo doc is the source of truth for its own language; its translation into
-- the other language is a derived artifact produced on demand by the built-in
-- Claude runner (subscription, zero paid API tokens) and cached here so the tab
-- shows it instantly without a deploy. Additive only — creates one table.

CREATE TABLE IF NOT EXISTS public.doc_translations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Repo path with any language suffix and .md stripped, e.g. "docs/foo" —
  -- the logical document that both language versions share.
  doc_key      text NOT NULL,
  -- The repo file this translation was produced FROM (docs/foo.md).
  source_path  text NOT NULL,
  -- Which language THIS row holds.
  target_lang  text NOT NULL CHECK (target_lang IN ('he', 'en')),
  title        text,
  content      text,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'ready', 'error')),
  error        text,
  -- Short fingerprint of the source content at translation time; when the
  -- source file changes the tab can offer "source updated — re-translate".
  source_hash  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_key, target_lang)
);

COMMENT ON TABLE public.doc_translations IS
  'On-demand translations of repo docs/**.md into he/en, produced by the built-in Claude runner. docs/bilingual-docs-plan.md';
