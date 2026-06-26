-- smrtReach: per-campaign email body font size.
--
-- The font *family* is fixed in code (EMAIL_FONT_STACK — Google Sans with safe
-- fallbacks) and applied identically to the sent HTML (send-service/test-send)
-- and the compose editor, so the editor is a faithful preview of the inbox.
-- The *size* is author-controlled per campaign; default 14px.
alter table smrtreach_campaign_email
  add column if not exists font_size smallint not null default 14;
