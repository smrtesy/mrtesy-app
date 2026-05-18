-- Platform Integration Layer
-- notifications, app_events, entity_links, org error handler
-- All tables are platform-level — never owned by a single app.

-- ── notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  app_slug     text        NOT NULL,
  type         text        NOT NULL
               CHECK (type IN ('info', 'warning', 'success', 'action_required')),
  title        text        NOT NULL,
  body         text,
  link         text,
  entity_type  text,
  entity_id    uuid,
  from_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  is_read      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications(user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_org_idx
  ON notifications(org_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_owner" ON notifications;
CREATE POLICY "notifications_owner" ON notifications
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── app_events ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_app   text        NOT NULL,
  event_type   text        NOT NULL,
  entity_type  text        NOT NULL,
  entity_id    uuid        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}',
  processed_by text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_events_org_type_idx
  ON app_events(org_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS app_events_pending_idx
  ON app_events(created_at DESC)
  WHERE array_length(processed_by, 1) IS NULL;

ALTER TABLE app_events ENABLE ROW LEVEL SECURITY;

-- app_events are backend-only; no direct client access
DROP POLICY IF EXISTS "app_events_deny_all" ON app_events;
CREATE POLICY "app_events_deny_all" ON app_events
  USING (false);

-- ── entity_links ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_links (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_app    text        NOT NULL,
  source_entity text        NOT NULL,
  source_id     uuid        NOT NULL,
  target_app    text        NOT NULL,
  target_entity text        NOT NULL,
  target_id     uuid        NOT NULL,
  link_type     text        NOT NULL
                CHECK (link_type IN ('related', 'created_from', 'blocks', 'resolves')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_app, source_id, target_app, target_id)
);

CREATE INDEX IF NOT EXISTS entity_links_source_idx
  ON entity_links(source_app, source_id);

CREATE INDEX IF NOT EXISTS entity_links_target_idx
  ON entity_links(target_app, target_id);

ALTER TABLE entity_links ENABLE ROW LEVEL SECURITY;

-- Org members can read links for their org
DROP POLICY IF EXISTS "entity_links_org_select" ON entity_links;
CREATE POLICY "entity_links_org_select" ON entity_links
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- ── organizations.error_handler_user_id ───────────────────────────────────────
-- Null = route to org owner (default). Owner/admin can override in org settings.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS error_handler_user_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;
