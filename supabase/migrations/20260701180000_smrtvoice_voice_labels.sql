-- smrtVoice: per-org custom display name for a Resemble voice.
--
-- Lets the user rename any voice in the library (mine or stock) to something
-- meaningful. Stored per org, keyed by the Resemble voice uuid; the official
-- Resemble name is still shown small alongside it.

CREATE TABLE IF NOT EXISTS smrtvoice_voice_labels (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resemble_voice_id text NOT NULL,
  display_name      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, resemble_voice_id)
);

ALTER TABLE smrtvoice_voice_labels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_voice_labels_org_members" ON smrtvoice_voice_labels;
CREATE POLICY "smrtvoice_voice_labels_org_members" ON smrtvoice_voice_labels
  FOR ALL
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS smrtvoice_voice_labels_org_idx ON smrtvoice_voice_labels(org_id);

DROP TRIGGER IF EXISTS smrtvoice_voice_labels_updated_at ON smrtvoice_voice_labels;
CREATE TRIGGER smrtvoice_voice_labels_updated_at BEFORE UPDATE ON smrtvoice_voice_labels
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();
