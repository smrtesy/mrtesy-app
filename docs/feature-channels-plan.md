# תוכנית: ערוצי-בשלות (Feature Channels) — גרסת בטא מול גרסה רזה

> **סטטוס:** טיוטה לאישור. לא נבנה שום קוד עד שהמסמך מאושר.
> **נכתב:** 2026-08-06. **קורא ראשי:** חנוך (אישור), איימן (מימוש).
> מבוסס על שתי חקירות של התשתית הקיימת בריפו — כל נקודת השתלבות ממופה לקובץ אמיתי.

## 1. המטרה

להריץ את אותה אפליקציה בשני **ערוצי בשלות**:

| | ערוץ **בטא** | ערוץ **רזה** (stable) |
|---|---|---|
| מי | חנוך (וצוות נבחר) | לקוחות / משתמשים רגילים |
| מה רואים | הכל — כל מסך וכל פיצ'ר | רק מה שסומן "מוכן/מאומת" |
| קשר | על-קבוצה | תת-קבוצה של הבטא |

**מה זה לא:** זה **אורתוגונלי לחלוטין** למערכת ההרשאות הקיימת (`permissions` / app-entitlements). הרשאות = "מי *מורשה* למה". ערוץ = "איזו *רמת-בשלות* של המוצר רואים". שני צירים נפרדים; המנגנון החדש יושב *לצד* ההרשאות ולא נוגע בהן.

## 2. ההחלטה הארכיטקטונית שהתגבשה

הדיון עבר על שלוש רמות בידוד. ההכרעה:

| גישה | הכרעה |
|---|---|
| **A — ערוץ-תצוגה** (deployment אחד, flag מסתיר/מציג) | **ברירת מחדל.** פותר את רוב המקרים (פיצ'רים חדשים ונפרדים) בזול, לפי-שימוש |
| **B — גרסה-לצד-גרסה** (V1/V2 בקוד, `intent`) | **חריג מנוהל.** רק כשפיצ'ר בבטא משנה התנהגות של פיצ'ר קיים ברזה |
| **C — שני deployments** (branch stable נפרד) | **נדחה לעכשיו.** מחיר תפעולי קבוע — crons כפולים על DB אחד, edge-functions בפרויקט אחד, backport. נשקל מחדש רק אם forks קבועים יתרבו (ראה §9) |

**עקרונות שהוכרעו בדיון:**
1. **לא כל שינוי בפיצ'ר קיים דורש B.** תיקון-באג / שיפור תואם-לאחור נכנס ישר לקוד המשותף ומשפר את שני הערוצים — בלי B. רק שינוי שעלול *לשבור* את החוויה היציבה נכנס ל-B.
2. **שני סוגי זוגות V1/V2, ורק אחד מהם עם deadline:**
   - `intent: migrate` — הבטא תחליף את הרזה בסוף. תזכורת-קידום *רכה*, לפי תאריך שאתה קובע (לא מספר קבוע).
   - `intent: fork` — פיצול קבוע *מכוון*; הרזה נשארת בישן, אולי לנצח. **אין deadline, לא נחסם.**
3. **חלוקת אחריות AI ↔ DB:** ה-AI **לא** מעורב בכל צפייה במסך (יקר בטוקנים). ה-AI כותב שורת-DB **פעם אחת** ברגע שהוא נוגע בקוד; מאותו רגע המסך קורא מה-backend לבדו.

## 3. מבנה מול מצב — ההפרדה שפותרת את "קובץ או DB"

זו הנקודה הקריטית שהחקירה חשפה. שאלת "מרשם בקובץ או ב-DB?" **אינה בינארית** — לכל אחד תפקיד:

| | **מבנה** (structure) | **מצב** (state) |
|---|---|---|
| מה | אילו פיצ'רים קיימים, לאיזה מסך שייכים, איפה בקוד (`code_ref`), `intent` | מה דלוק בכל ערוץ, איזו גרסה, תאריך עדכון, קישור-הסבר |
| איפה | **קובץ בקוד** — `src/lib/feature-registry.ts` (רזה, כמו `site-map.ts`) | **DB** — טבלת `feature_channels`, נערכת במסך אדמין |
| מי כותב | ה-AI, באותו commit של שינוי הקוד | מסך האדמין (הכפתור שלך) + ה-AI פעם אחת |
| נאכף | **hook ב-push** (git רואה את הקובץ) | — (המסך קורא, אין מה לאכוף) |

**למה ההפרדה הכרחית:** ה-hook עובד על `git diff` בלבד — הוא **לא יכול** לאמת שרשומת DB עודכנה, כי ה-DB אינו חלק מה-diff. לכן המבנה חייב לחיות בקוד (שם ה-hook יכול לאכוף שכל פיצ'ר-בקוד רשום), והמצב הדינמי חי ב-DB (שם המסך קורא אותו בלי AI). זה בדיוק מיישב את מה שביקשת: **המסך קורא מ-DB בלי טוקנים, וה-hook עדיין אוכף שלא שכחת לרשום פיצ'ר.**

## 4. הארכיטקטורה על התשתית הקיימת

### 4.1 אחסון הערוץ של המשתמש
עמודה תוספתית (דפוס `ADD COLUMN` קיים בשתי הטבלאות):
- `user_settings.release_channel text` — `'stable' | 'beta'`, ברירת מחדל `'stable'`. (הטבלה keyed-by-`user_id`, כבר צוברת עמודות-העדפה.)
- `organizations.release_channel text` — ברירת-מחדל לארגון (כמו הדפוס של `error_handler_user_id`).
- **רזולוציה:** override של המשתמש גובר על ברירת-המחדל של הארגון.

### 4.2 פתירת הערוץ — נקודת חיבור אחת
ב-`src/app/[locale]/(app)/layout.tsx` (שורה ~196) כבר נפתרות 4 עובדות-גישה ומוזרקות ל-`AppAccessContext`. מוסיפים **עובדה חמישית**:
```ts
// AppAccess (src/contexts/AppAccessContext.tsx)
channel: "stable" | "beta"
features: Record<string, { visible: boolean; version: string }>
```
ה-layout טוען את `feature_channels` פעם אחת, מצליב מול הערוץ, ומזריק מפה מוכנה — בדיוק כמו ש-`restrictedResources` נפתר היום. **אפס AI, אפס טוקנים** בצפייה.

### 4.3 הסתרה/הצגה בפרונט — חיקוי `ResourceGuard`
קומפוננטה חדשה `<FeatureGate featureId="...">` על תבנית `src/components/platform/permissions/ResourceGuard.tsx` + hook `useFeature(featureId)`:
```tsx
const { visible, version } = useFeature("whatsapp-reader");
if (!visible) return null;
return version === "v2" ? <WhatsAppReaderV2 /> : <WhatsAppReader />;
```
- **גישה A** (הסתר/הצג): `visible` בלבד.
- **גישה B** (פיצול): `version` בוחר איזו קומפוננטה לרנדר.

### 4.4 סכימת `feature_channels` (המצב ב-DB)
```
create table feature_channels (
  id             uuid primary key default gen_random_uuid(),
  feature_id     text not null unique,      -- kebab, תואם ל-feature-registry.ts
  screen_key     text not null,             -- path מ-site-map.ts, למשל "/whatsapp"
  title          text not null,
  title_he       text,
  stable_enabled boolean not null default false,  -- הכפתור, ערוץ רזה
  beta_enabled   boolean not null default true,   -- הכפתור, ערוץ בטא
  stable_version text not null default 'v1',       -- איזו גרסה ברזה
  beta_version   text not null default 'v1',       -- איזו גרסה בבטא
  intent         text not null default 'fork'      -- 'fork' | 'migrate'
                 check (intent in ('fork','migrate')),
  promote_by     date,                       -- רק ל-migrate, רך, אופציונלי
  notes_url      text,                        -- קישור להסבר על השינויים
  last_changed_at timestamptz not null default now(),
  created_at     timestamptz not null default now()
);
```
כל שדה עונה על פריט מהמסך שביקשת: `stable/beta_enabled` = הכפתור · `stable/beta_version` = "איזו גרסה בכל ערוץ" · `last_changed_at` = "תאריך עדכון אחרון" · `notes_url` = "קישור להסבר".

### 4.5 מסך האדמין — חיקוי `AppStatusCard`
מסך `/admin/features`, בנוי בדיוק על התבנית של `/admin/apps`:
- **דף route דק** → קומפוננטת client ב-`src/components/admin/FeaturesClient.tsx`.
- **היררכיה לפי מסכים:** מקבצים את הפיצ'רים לפי `screen_key`, בסדר של `SITE_MAP` (`src/lib/site-map.ts`). לכל מסך — כרטיס, ובתוכו הפיצ'רים שלו עם סטטוס+גרסה+כפתור.
- **קריאה/עדכון:** `api()` מ-`@/lib/api/client.ts` עם `noOrg: true`:
  - `GET /api/admin/features` — הרשימה (מצליב `feature-registry.ts` × `feature_channels`).
  - `PATCH /api/admin/features/:featureId` — upsert-by-key על `feature_channels`, per-field validation, כמו `PATCH /admin/apps/:slug/status`.
- **שרת:** `server/src/modules/admin/features/routes.ts`, ממותג ב-`adminRouter` תחת הגייט הקיים `router.use("/admin", requireAuth, requireSuperAdmin)`.
- **הכפתור פועל מיד בלי deploy:** הוא כותב DB, והפרונט (§4.2) קורא את ה-DB בטעינה הבאה. זה feature-flag אמיתי.

### 4.6 ה-hook האוכף
`.claude/hooks/feature-registry-guard.sh`, מועתק כשלד מ-`map-guard.sh` (אותו stdin→`jq`→זיהוי-push→פתירת-repo→fail-open→`exit 2`+stderr עברית→`FEATURE_GUARD_SKIP=1` bypass), רשום ב-`.claude/settings.json` במערך ה-PreToolUse/Bash הקיים. מה הוא בודק:
1. **פיצ'ר-קוד חדש בלי רישום:** ה-diff הוסיף קומפוננטה בדפוס גרסה (`*V2` / `code_ref` חדש) אך `src/lib/feature-registry.ts` לא עודכן באותו טווח → חסימה ("רשום את הפיצ'ר במרשם").
2. **אזהרת תיקון-כפול (fork):** נגעת בקובץ שיש לו זוג פעיל במרשם → **אזהרה** (לא חסימה): "יש כאן V1/V2 פעיל — בדוק אם התיקון צריך להיכנס לשתי הגרסאות".

ה-hook **לא** מנסה לאמת את ה-DB (בלתי-אפשרי מ-git, ומפר fail-open). הוא אוכף רק את המבנה-בקוד; המצב ב-DB באחריות המסך.

## 5. החור שחוצה את כל הגישות — DB משותף

Supabase אחד. פיצ'ר בבטא שכותב נתונים בפורמט חדש או משנה סכימה עלול לשבור את הרזה שרצה על קוד ישן. **חוק-על:** כל שינוי ל"רזה מוגנת" חייב להיות **תואם-לאחור לסכימה**. מיגרציות נשארות forward-only ותוספתיות. זה מגביל מה בכלל אפשר לבודד, בכל הגישות.

## 6. שלבי מימוש (אחרי אישור)

| שלב | תוכן | מנוע |
|---|---|---|
| 1 | מיגרציה: `release_channel` ב-`user_settings`+`organizations`, טבלת `feature_channels` | DB (תוספתי — מוחל עצמאית) |
| 2 | פתירת `channel`+`features` ב-`layout.tsx`, הרחבת `AppAccessContext` | Frontend |
| 3 | `<FeatureGate>` + `useFeature()` + `feature-registry.ts` | Frontend |
| 4 | מסך `/admin/features` + `GET/PATCH /api/admin/features` | Frontend + Backend |
| 5 | `feature-registry-guard.sh` + רישום ב-`settings.json` | Hooks |
| 6 | טוגל-ערוץ למשתמש (איפה שנחליט — ראה §7 ש"ב) | Frontend |

## 7. שאלות פתוחות להכרעה לפני מימוש

1. **יחידת הסימון:** רק מסך שלם, או גם פיצ'ר בתוך מסך? (הסכימה תומכת בשניהם; `screen_key`=מסך, `feature_id`=יחידה. צריך רק להחליט כמה דק יורדים.)
2. **מי קובע ערוץ:** אתה מגדיר לכל משתמש, המשתמש מדליק "מצב בטא" בעצמו, או שילוב? (משפיע על §6 שלב 6.)
3. **ברירת מחדל למסך/פיצ'ר חדש:** נכנס כ**רזה (מוכן)** או כ**בטא (מוסתר עד אישור)**? (בסכימה כרגע: `beta_enabled=true`, `stable_enabled=false` → ברירת המחדל "בטא-בלבד עד שתאשר". שנה אם רוצים הפוך.)
4. **הטוגל למשתמש:** אם המשתמש מדליק בעצמו — איפה? (מסך `/account` / `/settings`.)

## 8. מתי לשקול מעבר ל-C (שני deployments)

ה-`intent:fork` במרשם **סופר בשבילך** כמה פיצולים קבועים נצברים. אם הם מתרבים והופכים לכאב תחזוקה (תיקון-כפול חוזר, drift), זה הסימן שגישת **C-frontend-בלבד** (branch `stable` נפרד ב-Vercel, backend משותף כדי שה-crons ירוצו פעם אחת) הפכה משתלמת. עד אז — A+B זול יותר, ומשלמים רק לפי-שימוש.
