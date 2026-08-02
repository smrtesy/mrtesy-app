# תוכנית — בדיקת-דף אוטומטית בדפדפן שמחקה משתמש אמיתי

מסמך לאישור. הפיצ'ר: בכל תהליך שינוי-קוד שנוגע במסך, Claude **מציע** להריץ
בדיקה אוטומטית שפותחת את הדף בדפדפן אמיתי ומחקה משתמש — והמשתמש מאשר כן/לא
(לא חובה). חל על **mrtesy-app בלבד**.

## למה זה, ומה יש כבר

היום פרוטוקול ה-pre-push בודק build + greps + סקירת-סוכן — כולם **סטטיים**.
אף שלב לא **פותח את הדף בפועל**, כך שרגרסיה שקורית רק בזמן-ריצה (שגיאת JS
בעמידה, קריאת API שנשברת, אלמנט שלא נטען, כפתור שלא מגיב) עוברת עד שהמשתמש
נתקל בה. הפיצ'ר סוגר את הפער: מריץ את הדף כמו משתמש ומאמת שהוא באמת עובד.

**התשתית כבר קיימת** ומנוצלת מחדש — לא בונים מאפס:
- `server/src/modules/claude/browser-helper.ts` — CLI שמפעיל Chromium headless,
  מתחבר לאפליקציה כמשתמש (עוגיות), נכנס למסך, מצלם, מריץ סקריפט Playwright מלא.
- `server/src/modules/claude/app-access.ts` — `mintAppAccess()` מנפיק session
  אמיתי קצר-מועד למשתמש (תבנית `dev-login`: ‏`generateLink`+`verifyOtp` עם
  service-role) ו-`sessionCookies()` שמסדר אותו לעוגיית `sb-<ref>-auth-token`
  בדיוק בפורמט שהאפליקציה קוראת. הלוגיקה מאומתת מול קוד-הספריות.
- Chromium מותקן מראש: `/opt/pw-browsers/chromium`; `playwright-core` כבר תלות
  ברפו (`PLAYWRIGHT_BROWSERS_PATH` מוגדר).

## עקרון-על: חייבים להריץ את ה-build המקומי

הבדיקה בודקת את הקוד ה**משונה**, שעדיין לא נפרס. האתר החי (`app.smrtesy.com`)
רץ על `main` ישן — בדיקה מולו לא תשקף את השינוי. לכן ההרנס מריץ את הענף
מקומית (`next dev` על `localhost:3000`) ומפנה אליו את הדפדפן.

## ההתחברות — session אמיתי, לא עקיפה

יש עקיפת-אימות בפיתוח (`NEXT_PUBLIC_DEV_BYPASS_AUTH`), אבל היא רק עוברת את
מסך הכניסה — **בלי טוקן אמיתי קריאות ה-API ל-backend נדחות**, ומסכים מבוססי-
נתונים נשברים. ל"תרחישי אינטראקציה מלאים" צריך session אמיתי. לכן:

**endpoint פנימי חדש ב-backend** — `GET /api/claude-session/app-access`,
מוגן ב-`x-cron-secret` (אותו דפוס כמו `/api/claude-session/proposal`),
מקבל `user_id`, ומחזיר `{ cookies, publicEnv }`:
- `cookies` — מ-`mintAppAccess(user_id)` הקיים (session אמיתי → עוגיות).
- `publicEnv` — ערכי `NEXT_PUBLIC_*` הדרושים להרצה מקומית (ראה למטה). כולם
  **ציבוריים** (נשלחים ממילא ל-frontend בדפדפן), כך שהחזרתם דרך endpoint
  מוגן-secret אינה חושפת סוד.

**אפס secret חדש בסשן:** כבר יש לנו `SMRTBOT_INTERNAL_SECRET`,
`SMRTESY_BACKEND_URL`, ו-`SMRTTASK_USER_ID` — כל מה שההרנס צריך כדי לקרוא
ל-endpoint. הטוקן קצר-מועד (ברירת-מחדל Supabase שעה), מספיק לבדיקה בודדת.

## הארכיטקטורה — שלושה חלקים

### 1. הרנס: `scripts/page-check.mjs` (שורש mrtesy-app)
צעדי ההרצה:
1. קריאה ל-`GET {SMRTESY_BACKEND_URL}/api/claude-session/app-access?user_id=$SMRTTASK_USER_ID`
   עם כותרת `x-cron-secret: $SMRTBOT_INTERNAL_SECRET` → `{ cookies, publicEnv }`.
2. כתיבת `.env.local` זמני מ-`publicEnv` (‏gitignored; נמחק בסוף).
3. הפעלת `next dev` ברקע; המתנה עד ש-`localhost:3000` מגיב (polling, timeout).
4. הפעלת Chromium דרך `playwright-core` עם
   `executablePath: /opt/pw-browsers/chromium`; התקנת ה-cookies ל-context;
   האזנה ל-`console.error` + `pageerror` + תגובות רשת נכשלות (4xx/5xx).
5. הרצת **תרחיש האינטראקציה** של המסך (ראה חלק 3).
6. איסוף: שגיאות קונסולה/דף, קריאות רשת שנכשלו, צילומי-מסך לצעדים המרכזיים.
7. כיבוי הדפדפן + `next dev`, מחיקת `.env.local`. יציאה 0 = עבר; ≠0 = נכשל,
   עם דוח ברור מה נשבר (אף פעם לא נראה כמו הצלחה בכשל).

`.env.local` הדרוש (מ-`publicEnv`): `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_BACKEND_URL`,
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_ADMIN_EMAIL`,
ו-`NODE_ENV=development`.

### 2. endpoint ב-backend
`server/src/modules/claude/` (או `smrttask/routes/claude-session.ts` ליד
ה-proposal), מנוצל מחדש: `mintAppAccess` + מרכיב `publicEnv` מ-env השרת.
מוגן-secret, מכונה-למכונה, בלי JWT — כמו שאר ראוטי ה-machine.

### 3. תרחישי אינטראקציה + החיווט לתהליך
- **תרחישים:** קבצי-תרחיש per-מסך תחת `.claude/page-checks/<screen>.mjs`,
  כל אחד `export default async ({ page, goto, expect, shot }) => { … }` —
  ניווט, לחיצות, מילוי טפסים, מעבר בין מסכים, אימות תוצאה. ההרנס בוחר את
  התרחיש למסך שהשתנה; אם אין — Claude כותב אחד תוך כדי (המסך ידוע מה-diff).
- **החיווט (מציע, לא חובה):** שורה בפרוטוקול ה-pre-push ב-`CLAUDE.md` —
  "אם ה-diff נוגע במסך (`src/app/**` / `src/components/**`), הצע להריץ
  `page-check` על המסך; הרץ רק על 'כן' מהמשתמש." בנוסף **סקיל**
  `.claude/skills/page-check/` להפעלה חופשית מתי שרוצים.

## מה צריך להקים (מינימלי)

בסשן כבר קיימים כל ה-secrets הדרושים להרנס. הדבר היחיד לוודא: של-backend
(Railway) יש את ערכי ה-`NEXT_PUBLIC_*` להחזרה ב-`publicEnv`. ה-anon key
ציבורי וזמין ב:
- **Vercel** → פרויקט mrtesy-app → Settings → Environment Variables →
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Supabase** → Project Settings → API → "anon public":
  https://supabase.com/dashboard/project/exjnlghuzuvqedlltztz/settings/api

אם ל-backend חסר משתנה — מוסיפים אותו למשתני השירות ב-Railway, או (חלופה
חד-פעמית) מניחים `.env.local` ידני בשורש הרפו. שני המסלולים מתועדים בסקיל.

## גבולות וסיכונים

- **זמן:** העלאת `next dev` לוקחת ~10–30ש'; ההרנס ממתין למוכנות עם timeout.
- **יציבות:** תרחיש-אינטראקציה עמוק שביר יותר מבדיקת-עשן. לכן כל תרחיש נשען
  על בסיס-עשן קשיח (טעינה + אפס שגיאות קונסולה + אלמנט-עוגן) לפני צעדי
  האינטראקציה, כך שכשל מבחין בין "הדף מת" ל"הצעד ה-3 נכשל".
- **נתונים:** התרחיש רץ עם המשתמש האמיתי (`SMRTTASK_USER_ID`) על ה-DB
  האמיתי. תרחישים שכותבים נתונים — קריאה-בלבד כברירת מחדל; כתיבה רק בתרחיש
  מפורש, עם ניקוי אחריו. עלות אפס (בלי API בתשלום — Claude על המנוי).

## שלבי מימוש (אחרי אישור)

1. endpoint `app-access` ב-backend (מנצל `mintAppAccess`) + החזרת `publicEnv`.
2. `scripts/page-check.mjs` + `.env.local` ל-gitignore.
3. סקיל `.claude/skills/page-check/` + תיקיית `.claude/page-checks/` עם תרחיש-
   לדוגמה למסך אחד (למשל `/tasks`).
4. שורת-החיווט (מציע/כן-לא) בפרוטוקול ה-pre-push ב-`CLAUDE.md`.
5. הרצת קצה-לקצה על מסך קיים להוכחת עבודה; pre-push מלא לשינוי ה-backend.
