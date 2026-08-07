-- מחסן רעיונות — צ'אט קליל בקונסולת קלוד שמטרתו תיעוד רעיון בלבד.
-- עמודה תוספתית על claude_threads: 'normal' (ברירת מחדל, כל הצ'אטים הקיימים) או
-- 'idea' (צ'אט מחסן רעיונות — בלי ריפו, בלי הוראות-קבועות כבדות; preamble ייעודי).
-- תוספתי והפיך: כל השורות הקיימות מקבלות את ה-DEFAULT, כך שה-CHECK עובר מיד.
ALTER TABLE public.claude_threads
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'normal'
    CHECK (kind IN ('normal', 'idea'));

COMMENT ON COLUMN public.claude_threads.kind IS
  'normal | idea — idea = צ''אט מחסן רעיונות (תיעוד רעיון קליל, בלי ריפו/הוראות-קבועות)';
