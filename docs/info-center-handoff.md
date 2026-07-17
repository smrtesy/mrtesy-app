# smrtInfo — Runbook למילוי מאגר המידע (חשבון Claude Code נפרד)

האפליקציה **smrtInfo** כבר נבנתה (סכמה, שרת, UI). המסמך הזה מסביר לחשבון Claude Code
נפרד איך **למלא את מאגר המידע** — כלומר להריץ חילוץ עובדות (ב**סוננט**) על היסטוריית
ההודעות הקיימת. חלוקת העבודה: הקוד נבנה בסשן הראשי; מילוי המאגר נעשה כאן.

---

## 0. מה עושים
פונים לנקודת-קצה שכבר קיימת בשרת, שמריצה את פייפליין החילוץ המלא (סוננט + embeddings
של Voyage + דדופ/supersede + ניתוב סיסמאות ל-smrtVault) על אצווה של הודעות:

```
POST {BACKEND}/api/info/extract/batch
Header: x-cron-secret: <SMRTBOT_INTERNAL_SECRET או CRON_SECRET>
Body (אחת משתי דרכים):
  { "user_id": "<uuid>", "source_message_ids": ["<id>", ...] }   # מפורש
  { "user_id": "<uuid>", "limit": 20, "before": "<created_at?>" } # עימוד אוטומטי
```
תשובה: `{ messages, factsStored, factsSuperseded, secretSuggestions, dropped, costUsd, nextBefore }`.
`nextBefore` = ה-`created_at` הישן ביותר שעובד — מעבירים אותו כ-`before` בקריאה הבאה
כדי להתקדם אחורה בזמן. אידמפוטנטי: הרצה חוזרת לא יוצרת עובדות/הצעות כפולות.

---

## 1. מה החשבון הנפרד צריך
| פריט | ערך |
|---|---|
| `BACKEND` | ה-URL של שרת ה-Express (Railway) — `NEXT_PUBLIC_BACKEND_URL` / `SMRTESY_PUBLIC_URL` |
| `x-cron-secret` | הערך של `SMRTBOT_INTERNAL_SECRET` (או `CRON_SECRET`) מ-Railway |
| `user_id` | ה-UUID של המשתמש (chanoch) — מ-`auth.users` דרך Supabase MCP |
| Supabase MCP (אופציונלי) | לעימוד לפי `source_messages` ולאימות התוצאה |

אין צורך ב-JWT — הנתיב מאובטח בסוד משותף (כמו `/sync/run-scheduled`).

---

## 2. זרימת עבודה מומלצת
1. שליפת ה-`user_id` (Supabase MCP: `select id from auth.users where email='chanoch@maor.org'`).
2. לולאה: קריאה עם `{ user_id, limit: 20 }`, ואז המשך עם `before: nextBefore` עד
   ש-`messages` חוזר 0. עצור מוקדם אם רוצים רק את ה-N האחרונים.
3. לאחר כל אצווה — אפשר לבדוק ב-UI (מסך "מרכז מידע") או ב-DB
   (`select count(*) from info_facts`) שהעובדות נכנסות.
4. עלות מצטברת: סכום `costUsd` שחוזר בכל אצווה (וגם נרשם ל-`ai_usage`).

> החילוץ תמיד רץ ב**סוננט** בצד השרת — אין צורך שהחשבון הנפרד יריץ מודל בעצמו; הוא רק
> מתזמן את האצוות. כך האיכות והלוגיקה זהות לפייפליין ה-live.

---

## 3. איכות המאגר (למה לשים לב)
- **פרופיל הקשר** משפיע על סיווג אישי/ארגוני. כדאי שהמשתמש ימלא אותו קודם (מסך
  smrtInfo → אייקון הגדרות) כדי שהחילוץ יסווג נכון. בלי פרופיל → הרבה "לא מסווג".
- עובדות בביטחון גבוה נכנסות מאומתות; נמוך → "לא מאומת" (מסומן ב-UI לאישור).
- סיסמאות שזוהו → **הצעות שמירה** (לא נשמרות אוטומטית); המשתמש מאשר במסך.

---

## 4. אימות (Definition of Done למילוי)
- `select count(*), scope from info_facts group by scope;` — יש עובדות, מחולקות scope.
- שאלת-בוחן ב-UI: "מה חברת הביטוח של FPL?" מחזירה תשובה עם קישור למקור.
- `secretSuggestions` > 0 אם היו סיסמאות בהיסטוריה → מופיעות במסך לאישור.

---

*נכתב 2026-07-15. נלווה ל-`docs/info-center-plan.md`. הקוד: `server/src/modules/smrtinfo/`.*
