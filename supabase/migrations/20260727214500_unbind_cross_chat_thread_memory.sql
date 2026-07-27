-- Repair: unbind thread_memory pointers that cross parties.
--
-- A WhatsApp/SMS thread key is a PERSON (whatsapp:<chatId>), so
-- thread_memory.related_task_id must only ever point at a task born in THAT
-- chat. The cross-source duplicate matcher used to re-point the incoming
-- message's own chat at whatever task it matched, so one wrong match ("same
-- phone number: 3475848008 = 972584146670") permanently routed every future
-- message from that contact onto a stranger's matter — T1804 kept collecting
-- מענדי's messages on לאה's task, T276 collected four updates from the wrong chat.
--
-- ai-process now refuses to write such a pointer (see threadCrossesTask), so this
-- is a one-time cleanup of the rows written before that guard. Clearing
-- related_task_id only removes a wrong link: the chat's next message routes
-- normally through the per-matter router (which reads the chat's own sibling
-- tasks, never this pointer). The row's summary/state are left untouched.
--
-- Idempotent: re-running matches nothing once the pointers are clear.

-- The origin key is computed exactly as ai-process's threadKey() does, so the
-- cleanup and the runtime guard agree: a chat pointer is wrong whenever the
-- task's own thread key is known AND different — including a chat bound to a
-- GMAIL-born task. NULL-safe: a task with no derivable thread key (calendar,
-- Drive, a self-chat echo, a manually created task) never counts as crossing,
-- which is why the comparison is wrapped in IS DISTINCT FROM / IS NOT NULL
-- rather than a bare <> (that yields NULL, not TRUE, on a missing chatId).
UPDATE thread_memory tm
SET related_task_id = NULL,
    updated_at = now()
FROM tasks t
JOIN source_messages om ON om.id = t.source_message_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN om.source_type IN ('gmail', 'gmail_sent')
      THEN 'gmail:' || (om.metadata->>'threadId')
    WHEN om.source_type IN ('whatsapp', 'sms')
      THEN om.source_type || ':' || (om.metadata->>'chatId')
  END AS origin_key
) k
WHERE tm.related_task_id = t.id
  AND tm.thread_key ~ '^(whatsapp|sms):'
  AND k.origin_key IS NOT NULL
  AND k.origin_key IS DISTINCT FROM tm.thread_key;
