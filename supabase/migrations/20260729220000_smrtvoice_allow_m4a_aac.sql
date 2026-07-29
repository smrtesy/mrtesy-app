-- ============================================================
-- smrtVoice — widen storage bucket allowed MIME types
-- ============================================================
-- The clone uploader lets users upload recordings straight to the
-- `smrtvoice-audio` bucket via a signed URL. Browsers set the request's
-- Content-Type from the file's own type, and iPhone/Mac recordings (.m4a)
-- are reported as `audio/x-m4a` (sometimes `audio/m4a` / `audio/aac`).
-- The original bucket only allowed wav/mpeg/mp4, so those uploads were
-- rejected with:
--   400 {"statusCode":"415","error":"invalid_mime_type",
--        "message":"mime type audio/x-m4a is not supported"}
--
-- Downstream is format-agnostic: voice-engine rebuilds the clone dataset
-- with pydub/ffmpeg (`AudioSegment.from_file`), which decodes m4a/aac/ogg/
-- flac fine. So the only thing blocking these formats was this list.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/aacp',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm'
]
WHERE id = 'smrtvoice-audio';
