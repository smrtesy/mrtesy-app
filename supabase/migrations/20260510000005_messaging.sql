-- ============================================================================
-- Migration: messaging schema (Phase 5 — base platform feature).
--
-- Scope:
--   • Each conversation belongs to ONE organization.
--   • Conversations have members (currently 1-on-1 is the default; the schema
--     supports group chats by having ≥3 members).
--   • Messages are immutable text/markdown for now (delivery_status added later).
--
-- RLS:
--   • You can SELECT a conversation only if you're in its members list.
--   • You can SELECT messages of conversations you're in.
--   • All writes go through the Express API (service-role bypasses RLS) so RLS
--     here is purely a defence in depth for any future direct-Supabase reader.
-- ============================================================================

-- ─── conversations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text,                                   -- optional, for group chats
  is_group        boolean       NOT NULL DEFAULT false,
  created_by      uuid          NOT NULL REFERENCES auth.users(id),
  last_message_at timestamptz,                            -- denormalised for sort
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_org_last_msg
  ON conversations (organization_id, last_message_at DESC NULLS LAST);

-- ─── conversation_members ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid          NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid          NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  joined_at       timestamptz   NOT NULL DEFAULT now(),
  last_read_at    timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
  ON conversation_members (user_id);

-- ─── messages ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid          NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid          NOT NULL REFERENCES auth.users(id),
  content         text          NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages (conversation_id, created_at);

-- ─── Trigger: bump conversations.last_message_at on new message ──────────
CREATE OR REPLACE FUNCTION bump_conversation_last_message_at() RETURNS trigger AS $$
BEGIN
  UPDATE conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_bump_last ON messages;
CREATE TRIGGER trg_messages_bump_last
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION bump_conversation_last_message_at();

-- ─── RLS policies (defence in depth — writes go through Express) ─────────
ALTER TABLE conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;

-- conversations: visible to members
DROP POLICY IF EXISTS "conversations_select" ON conversations;
CREATE POLICY "conversations_select" ON conversations
  FOR SELECT USING (
    id IN (SELECT conversation_id FROM conversation_members WHERE user_id = auth.uid())
  );

-- conversation_members: each user sees their own membership rows
-- (cross-member listing goes through Express which uses service-role)
DROP POLICY IF EXISTS "conversation_members_select" ON conversation_members;
CREATE POLICY "conversation_members_select" ON conversation_members
  FOR SELECT USING (user_id = auth.uid());

-- messages: visible if you're a member of the conversation
DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select" ON messages
  FOR SELECT USING (
    conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = auth.uid())
  );
