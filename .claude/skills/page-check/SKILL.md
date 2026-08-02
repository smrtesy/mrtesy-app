---
name: page-check
description: בדיקת-דף אוטומטית בדפדפן שמחקה משתמש אמיתי — פותחת את המסך שהשתנה בקוד, מריצה תרחיש אינטראקציה מלא, ותופסת שגיאות זמן-ריצה שה-build לא רואה. הפעל כשמשנים מסך (src/app או src/components) ורוצים לוודא שהוא באמת עובד לפני push, או כשהמשתמש מבקש "תבדוק את הדף".
---
עברית מול המשתמש; קוד/נתיבים באנגלית.

## מה זה עושה
מריץ את הענף ה**משונה** מקומית (`next dev`), מתחבר כמשתמש אמיתי (session
שמנפיק ה-backend), פותח את המסך ב-Chromium המותקן מראש, מריץ תרחיש אינטראקציה,
ותופס `console.error` / `pageerror` / קריאות רשת שנכשלו (4xx/5xx) + צילומי-מסך.
יציאה 0 = עבר, ≠0 = נכשל. זה שלב זמן-הריצה שמשלים את ה-build/greps/סקירת-הסוכן
הסטטיים בפרוטוקול ה-pre-push. תוכנית מלאה: `docs/browser-page-test-plan.md`.

## מתי מציעים (לא חובה)
כשה-diff נוגע במסך (`src/app/**`, `src/components/**`) — **הצע** למשתמש להריץ
page-check על המסך שהשתנה, וקבל "כן/לא". אל תריץ בלי אישור. הפעלה חופשית
(המשתמש ביקש במפורש) — פשוט הרץ.

## איך מריצים
```
node scripts/page-check.mjs <path> [--scenario <file.mjs>]
# דוגמה:
node scripts/page-check.mjs /he/tasks --scenario .claude/page-checks/tasks.mjs
```
- `<path>` — הנתיב המדויק של המסך, כולל שפה (`/he/…`). ברירת-מחדל `/he/tasks`.
- בלי `--scenario` — בדיקת-עשן בלבד (המסך נטען, אין שגיאות, לא הופנה ל-login).
- `--no-auth` — דילוג על ההתחברות (dev-bypass); קריאות ה-API יידחו, למסך
  מבוסס-נתונים זה יראה שגיאות. השתמש רק לבדיקת-render טהורה.

## תרחישי אינטראקציה
קובץ תחת `.claude/page-checks/<screen>.mjs`, `export default` אסינכרוני שמקבל
`{ page, context, baseUrl, targetPath, goto, shot, log, expectVisible }`.
`page` הוא אובייקט Playwright מלא — לחיצות, מילוי, ניווט. דוגמה עובדת:
`.claude/page-checks/tasks.mjs`. אם אין תרחיש למסך — כתוב אחד תוך כדי (המסך
ידוע מה-diff); העדף לשמור אותו כדי שהבדיקה הבאה תרוץ שוב.

כללי כתיבת תרחיש:
- **קריאה-בלבד כברירת מחדל.** תרחיש שכותב נתונים (יוצר משימה, שולח טופס) —
  רק כשצריך, ולנקות אחריו. הכל רץ על ה-DB האמיתי עם המשתמש האמיתי.
- כל תרחיש עומד על בסיס-העשן (טעינה + אפס שגיאות + עוגן) שההרנס מריץ קודם,
  כך שכשל מבדיל בין "הדף מת" ל"הצעד הספציפי נכשל".

## דרישות סביבה
כבר קיימות בסשן: `SMRTESY_BACKEND_URL`, `SMRTBOT_INTERNAL_SECRET`,
`SMRTTASK_USER_ID`. אין secret חדש. אם ההרנס מדווח `missing: NEXT_PUBLIC_…` —
ל-backend חסר משתנה ציבורי להרצה המקומית. ה-anon key (ציבורי) נמצא ב:
- **Vercel** → פרויקט mrtesy-app → Settings → Environment Variables →
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Supabase**: https://supabase.com/dashboard/project/exjnlghuzuvqedlltztz/settings/api
מוסיפים אותו למשתני שירות ה-backend ב-Railway, או מניחים `.env.local` ידני
בשורש הרפו (חד-פעמי).

## תלות — endpoint ב-backend
ההתחברות נשענת על `GET /api/claude-session/app-access` (בקובץ
`server/src/modules/smrttask/routes/claude-session.ts`). הוא חי ב-backend רק
אחרי שהשינוי מוזג ל-`main` ונפרס ל-Railway. עד אז השתמש ב-`--no-auth`
לבדיקת-render. אחרי הפריסה — מסלול ה-session המלא פעיל.

## כללים תמיד
- לא להריץ בלי "כן" של המשתמש (כשמציעים בתהליך).
- עלות אפס — Chromium + Playwright על המנוי, בלי API בתשלום.
- דוח כשל תמיד ברור: מה נשבר ובאיזה צעד; לעולם לא להציג כשל כהצלחה.
