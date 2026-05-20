-- Split image OCR and audio transcripts out of whatsapp_messages.body_text
-- into their own columns. This lets the UI render the user-typed caption
-- as a regular message bubble and surface the AI-extracted text in a
-- distinct frame (light background, weak border, no "OCR:" / "תמלול:"
-- labels). Mixed Hebrew/English direction is handled per-line in the
-- renderer, not at the bubble level.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_ocr_text  text,
  ADD COLUMN IF NOT EXISTS audio_transcript text;

-- ─── Backfill existing rows ───────────────────────────────────────────
-- The webhook used to encode both pieces into body_text with these patterns:
--   audio:  "[תמלול אודיו]\n<transcript>"
--   image:  "כיתוב: <caption>\n\n[OCR]\n<ocr>"   (when caption present)
--   image:  "[OCR]\n<ocr>"                       (no caption)
-- We unpack the patterns into the dedicated columns. body_text becomes
-- just the caption (or NULL for audio).

UPDATE whatsapp_messages
SET audio_transcript = regexp_replace(body_text, E'^\\[תמלול אודיו\\]\n', ''),
    body_text        = NULL
WHERE message_type IN ('audio','voice')
  AND audio_transcript IS NULL
  AND body_text LIKE E'[תמלול אודיו]\n%';

-- Image with caption + OCR ("כיתוב: X\n\n[OCR]\nY")
UPDATE whatsapp_messages
SET media_ocr_text = substring(body_text from E'\\[OCR\\]\n(.+)$'),
    body_text      = substring(body_text from E'^כיתוב: (.+?)\n\n\\[OCR\\]')
WHERE message_type = 'image'
  AND media_ocr_text IS NULL
  AND body_text LIKE E'כיתוב: %\n\n[OCR]\n%';

-- Image with no caption ("[OCR]\nY")
UPDATE whatsapp_messages
SET media_ocr_text = regexp_replace(body_text, E'^\\[OCR\\]\n', ''),
    body_text      = NULL
WHERE message_type = 'image'
  AND media_ocr_text IS NULL
  AND body_text LIKE E'[OCR]\n%';
