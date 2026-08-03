# תוכנית איחוד הסודות — בית אחד, מודל אחד

> **סטטוס:** הצעה לאישור. עדיין לא נבנה כלום. נכתב בסשן
> `claude/secrets-management-organization-n28hs3`, 03/08/2026.
>
> **ההחלטה שהמסמך משרת:** היום בפלטפורמה יש **שני** מסכי-סודות מנותקים שמבלבלים
> זה את זה. התוכנית מאחדת אותם לבית אחד עם מודל-נתונים אחד, לפי הכרעת הבעלים:
> לקפל את סודות-האפליקציה **לתוך** סודות-הפלטפורמה, לתת לכל סוד לציין **אילו
> אפליקציות הוא משרת** (בלי טאב רביעי), ולהושיב את הכל **תחת אפליקציית וואלט**.

---

## 1. מה קיים היום — שתי מערכות, מאומת מהקוד

### א. `app_secrets` — הגדרות פר-אפליקציה בזמן ריצה ("הרגיל המוסתר")
- **מה זה:** ערכי הגדרות שה-backend (Express) **קורא בזמן ריצה** דרך
  `getAppSecret(appSlug, key, envFallback)` (`server/src/db.ts:139`). ערכים סודיים
  יושבים ב-Supabase Vault (`value_secret_id` → `vault_read_secret`); הגדרות לא-סודי
  ב-`value_text`; חסר → `process.env[envFallback]`. מטמון בזיכרון ל-10 שניות.
- **טבלה `app_secrets`** (קדמה לתיקיית המיגרציות — אין לה `CREATE` בקבצים; העמודות
  נגזרות מה-`onConflict` בראוטים): `app_id, key, is_secret, value_text,
  value_secret_id, updated_at`, ייחודי `(app_id, key)`.
- **נערך ב-** `/admin/apps/<slug>/secrets`
  (`src/app/[locale]/(app)/(platform)/admin/apps/[slug]/secrets/page.tsx`;
  backend `server/src/modules/admin/apps/routes.ts:252,439,494`).
- **בעיית התגלית:** אין לינק ישיר בתפריט. מגיעים רק דרך `/admin` → אפליקציות →
  בחירת אפליקציה → כרטיס "Secrets", ורק לאפליקציות שהסלאג שלהן ב-`ADMIN_SECTIONS`
  (`smrttask`, `smrtvoice`, `smrtreach`, `smrtbot`). לשאר — רק בהקלדת URL. במקביל,
  הטאב "Secrets" שכן רואים בתפריט מצביע על מערכת **ב** — וזה מקור הבלבול.
- **מה יושב שם בפועל** (`routes.ts:191-238`): `GEMINI_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_AUTOMATION`, `GITHUB_TOKEN`,
  הגדרות כמו `GEMINI_MODEL`/`CLAUDE_ACCOUNTS`/`META_API_VERSION` (smrttask);
  ו-`VOICE_ENGINE_*` לקריאה-בלבד (smrtvoice). **ובנוסף** — הטוקנים שמערכת **ב**
  עצמה משתמשת בהם: `RAILWAY_TOKEN`, `VERCEL_TOKEN`, `SUPABASE_ACCESS_TOKEN` — תחת
  `smrttask`.

### ב. `managed_secrets` — המרשם שדוחף לשירותי האחסון ("זה שבצילום המסך")
- **מה זה:** מגדירים מפתח לוגי פעם אחת → שומרים את ערכו ב-Vault → **משקפים ודוחפים**
  אותו החוצה למשתני-סביבה ב-Railway / Vercel / Supabase, עם זיהוי סטייה (drift)
  ולוג סנכרון. נבנה ב-02/08/2026; שלבים 1–3 (שלושת הספקים, קריאה+כתיבה) חיים.
  תיעוד: `docs/managed-secrets-plan.md`.
- **טבלאות** (`supabase/migrations/20260802150000_managed_secrets.sql`):
  - `managed_secrets` — `key_name` (ייחודי), `description`, `vault_secret_id`,
    `value_fingerprint`, `rotated_at`.
  - `managed_secret_targets` — יעד **דחיפה** אחד לכל שורה: `provider`
    (`railway|vercel|supabase`), `target_ref`, `env_var_name`, `environment`,
    ורישום נוכחות/טביעת-אצבע/סנכרון-אחרון.
  - `secret_sync_log` — לוג ביקורת נצבר, אף פעם לא ערך.
- **ממשק** `/admin/secrets` (`src/components/admin/ManagedSecretsClient.tsx`),
  פריט תפריט ב-`AdminNav.tsx`. הפאנל "מה קיים בכל שירות" שבצילום הוא
  `SecretsInventoryPanel.tsx` → `GET /api/admin/secrets/inventory`.
- **backend** `server/src/modules/admin/secrets/` (super-admin בלבד).

### היחס בין השתיים
שתיהן **אותו סוג דבר** (מפתחות/טוקנים) מוצפנים דרך אותו Supabase Vault, שתיהן
super-admin. ההבדל הוא רק ב**כיוון**:
- `app_secrets` = ה-backend שלנו **קורא** את הערך בזמן ריצה.
- `managed_secrets` = אנחנו **דוחפים** את הערך החוצה למשתני-סביבה.
- חלק מהמפתחות רוצים את **שניהם** (למשל `GEMINI_API_KEY`: ה-backend קורא אותו,
  *וגם* אולי דוחפים אותו ל-Railway). היום זה אומר לתחזק את הערך בשני מקומות.

החפיפה הזו היא בדיוק הסיבה ששני מסכי "סודות" מרגישים שגויים.

---

## 2. המודל המבוקש — סוד אחד, שני צירים

מושג יחיד, **"סוד פלטפורמה"** (שורת `managed_secrets`), מקבל ציר שני לצד יעדי-הדחיפה
הקיימים:

```
סוד פלטפורמה  (managed_secrets: key_name + ערך ב-Vault + description)
├── יעדי-שירות     (managed_secret_targets)   → דוחפים את הערך החוצה ל-Railway/Vercel/Supabase   [קיים היום]
└── שיוך-אפליקציות  (managed_secret_apps, חדש) → ה-backend קורא את הערך עבור האפליקציות האלה       [מקפל את app_secrets פנימה]
```

- לסוד יכולים להיות רק יעדי-שירות (סוד-פריסה טהור), רק שיוך-אפליקציות (סוד-ריצה
  כמו `GITHUB_TOKEN`), או שניהם (`GEMINI_API_KEY`).
- "אילו אפליקציות הוא משרת" = רשימת שיוך-האפליקציות, מוצגת ונערכת על כרטיס כל סוד
  בטאב **סודות פלטפורמה**. **בלי טאב רביעי.**

### שינויי הסכימה
1. **טבלה חדשה `managed_secret_apps`** (תוספתי — לא נוגע בנתונים):
   ```sql
   create table public.managed_secret_apps (
     id            uuid primary key default gen_random_uuid(),
     secret_id     uuid not null references public.managed_secrets(id) on delete cascade,
     app_id        uuid not null references public.apps(id) on delete cascade,
     -- שם-המפתח שה-backend קורא לאפליקציה הזו; ברירת מחדל = key_name של הסוד.
     runtime_key   text,
     created_at    timestamptz not null default now(),
     unique (secret_id, app_id, runtime_key)
   );
   ```
   RLS מופעל, בלי policies (service-role בלבד) — אותה נעילה כמו שלוש הטבלאות
   האחרות.
**זהו — אין שינוי נוסף בסכימה.** המאגר המאוחד נשאר **מאגר-סודות טהור** (כמו
`managed_secrets` היום, הכל דרך Vault). **הגדרות-מודלים לא נכנס פנימה** (ראו למטה),
ולכן *אין* צורך להוסיף `is_secret`/`value_text` ל-`managed_secrets`.

השינוי היחיד הוא `CREATE TABLE` תוספתי — **לא נוגע בשום נתון קיים** — ולכן ניתן
להחיל אותו בלי אישור, לפי כלל משמעת-המיגרציות. חלק ה**מיגרציה** (§4), שמעביר
נתונים, הוא זה שדורש תצוגה-מקדימה + חתימה.

### מה נשאר בחוץ — הגדרות-מודלים פר-אפליקציה (הכרעת הבעלים)
**סוד ≠ הגדרות.** מפתחות API וטוקנים (סודות אמיתיים) מתאחדים. אבל הגדרות תפעוליות
פר-אפליקציה — `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`, `CLAUDE_ACCOUNTS`,
`META_API_VERSION` — הן **לא סודות**, הן כבר שייכות לכל אפליקציה בנפרד, ואין סיבה
למרכז אותן. הן **נשארות פר-אפליקציה** בטבלת `app_secrets` (השורות עם
`is_secret = false`), ונערכות במסך ההגדרות של האפליקציה. כך `app_secrets` לא נעלמת
לגמרי — היא הופכת ל**מאגר הגדרות הפר-אפליקציוני**, והסודות בלבד יוצאים ממנה החוצה
אל המאגר המאוחד.

### קריאת-ריצה — איך `getAppSecret` ממשיך לעבוד
`getAppSecret(appSlug, key, envFallback)` הופך ל**קריאה כפולה**, המאוחד-קודם:

1. פותר `app` לפי slug (כמו היום).
2. **חדש:** מחפש `managed_secret` ש-`key_name = key` שלו (או
   `managed_secret_apps.runtime_key = key`) **משויך לאפליקציה הזו**. אם נמצא:
   `is_secret` → `vault_read_secret(vault_secret_id)`; אחרת `value_text`.
3. **נפילה-אחורה:** שורת `app_secrets` הקיימת (המסלול הישן, ללא שינוי).
4. **נפילה-אחורה:** `process.env[envFallback]` (ללא שינוי).
5. שומר במטמון (אותו TTL של 10 שניות).

הסדר הזה אומר: אחרי המיגרציה המאגר המאוחד עונה; עד שמפתח מהוגר, שורת `app_secrets`
הישנה עדיין עונה; שום דבר לא נשבר באף רגע.

---

## 3. הממשק — הכל תחת אפליקציית וואלט, שלושה טאבים

**הכרעת הבעלים: הכל תחת וואלט.** מסך `/vault` הופך למרכז יחיד עם שלושה טאבים.

| טאב | תוכן | הרשאה |
|---|---|---|
| **לוגין** | הכספת האישית הקיימת (`smrtvault_credentials`, פר-משתמש) | כל משתמש עם גישה לוואלט |
| **סודות פלטפורמה** | ה-`managed_secrets` המאוחד — עם שני הצירים (יעדי-שירות + שיוך-אפליקציות) | super-admin בלבד |
| **סודות לפי שרות** | תצוגת המלאי "מה קיים בכל שירות" (Railway/Vercel/Supabase) | super-admin בלבד |

**הרשאות — קריטי:** וואלט היום הוא אפליקציית משתמש-קצה (כל משתמש רואה את הלוגינים
הפרטיים שלו). שני הטאבים החדשים הם תשתית super-admin, ולכן **חייבים להיות גלויים רק
ל-super-admin**. משתמש רגיל רואה רק את טאב **לוגין**; הבעלים רואה את שלושתם במקום
אחד. הגיית ה-super-admin נעשית מול המידע הקיים ב-`AppAccessContext`; אם אי-פעם
נרצה חשיפה עדינה יותר, שכבת-ההרשאות (`requireResource`, קטלוג ב-
`src/lib/permissions/registry.ts`) היא המנגנון.

**טאב סודות פלטפורמה — הציר החדש בכרטיס.** על כל `SecretCard`, מתחת לחלק יעדי-השירות
הקיים, מוסיפים חלק **"אפליקציות שהסוד משרת"**:
- פקד קומפקטי, מכווץ כברירת מחדל (לפי כלל ה-UI הקומפקטי): שורת תגיות של סלאגי
  האפליקציות המשויכות + "＋" שפותח בורר-רבים של אפליקציות מ-`src/lib/apps/registry.ts`.
- הוספה/הסרה כותבות ל-`managed_secret_apps` דרך endpoints חדשים
  `POST/DELETE /api/admin/secrets/:id/apps`.
- המסך הישן `/admin/apps/<slug>/secrets` הופך ל**קריאה-מסוננת** של אותם נתונים
  (הסודות שמשרתים את האפליקציה), או להפניה — נכריע בזמן הבנייה; כך או כך, מקור-אמת
  אחד.

אף ערך חדש לא מוצג אף פעם; הכרטיס ממשיך להראות רק טביעות-אצבע/תגיות.

---

## 3.5 אפליקציית `smrtClaude` חדשה — בית לחשבונות Claude (הכרעת הבעלים)

**הרקע:** קונסולת Claude כבר קיימת — אבל כ**פיצ'ר-פלטפורמה**, לא כאפליקציה: `/claude`
בקבוצת `(platform)`, `server/src/modules/claude/`, ו-13 טבלאות `claude_*`. היא **לא**
רשומה ב-`src/lib/apps/registry.ts` (`APPS`).

**ההכרעה:** לקדם אותה לאפליקציה מן-המניין — `smrtClaude` (סלאג `smrtclaude`). זה לא
בנייה מאפס; הקוד והטבלאות קיימים. מה שנוסף הוא רשומת רجיстри + entitlement + שיוך
מפתחות החשבונות אליה. **הנימוק:** רק כאפליקציה עם entitlement אפשר לתת/למנוע גישה
למשתמשים שונים ל-Claude. (שכבת-ההרשאות `requireResource` נותנת שליטה דקה יותר *בתוך*
Claude; ה-entitlement הוא השער הגס — מי בכלל מקבל אותו.)

**מה עובר לשיוך `smrtclaude`** (במקום `smrttask` היום):
- **סודות:** `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_AI3`,
  `CLAUDE_CODE_OAUTH_TOKEN_AUTOMATION` — עוברים למאגר המאוחד עם שיוך-אפליקציה
  `smrtclaude`.
- **הגדרות (נשארות פר-אפליקציה):** `CLAUDE_ACCOUNTS`, `CLAUDE_ACCOUNT_LABEL`,
  `CLAUDE_ACCOUNT_LABEL_AI3`, `CLAUDE_ACCOUNT_LABEL_AUTOMATION` — עוברות למאגר
  ההגדרות של `smrtclaude`.

**היקף — שינוי מבני:** רשומת `APPS`, שורת `apps` + entitlement (מיגרציה), אולי הזזת
route group ל-`(smrtclaude)`, manifest, ועדכון `docs/codebase-map.md` באותו קומיט
(נאכף ב-`map-guard.sh`). זהו **שלב עצמאי** (§6, שלב 0) — נאשר את היקפו לפני scaffolding.

---

## 4. מיגרציה — להעביר את `app_secrets` הקיים פנימה, בבטחה

משנה-נתונים, ולכן רץ **רק אחרי** תצוגה-מקדימה מאושרת (כלל משמעת-המיגרציות).
**מהגרים רק את שורות ה-סוד** (`is_secret = true`); שורות הגדרות
(`is_secret = false`) נשארות ב-`app_secrets` כמאגר הגדרות הפר-אפליקציוני.

1. **תצוגה-מקדימה (`SELECT` לקריאה בלבד):** רשימת כל שורות `app_secrets` עם
   `is_secret = true` — סלאג האפליקציה, המפתח, האם כבר קיים `managed_secrets` עם
   אותו `key_name` (התנגשות שם), ומזהה ה-Vault. מציגים את הטבלה המלאה.
2. **מילוי-לאחור (סקריפט/מיגרציה חד-פעמית):** לכל שורת סוד ב-`app_secrets`:
   - upsert של שורת `managed_secrets` לפי `key_name = key`, עם **שימוש חוזר
     ב-`vault_secret_id` הקיים** (בלי הצפנה מחדש, בלי לקרוא ערך אי-פעם לזיכרון
     האפליקציה).
   - הוספת שורת `managed_secret_apps` שמקשרת את הסוד לאפליקציה.
   - **כלל התנגשות:** אם שתי אפליקציות כבר מחזיקות אותו `key_name` עם ערכים/מזהי-
     Vault **שונים**, **לא ממזגים** — התצוגה-המקדימה מסמנת אותן, ומשאירים אותן נפרדות
     דרך `runtime_key` או סיומת פר-אפליקציה. (היום אין כאלה — השמות ייחודיים בין
     אפליקציות — אבל הסקריפט חייב להיכשל-סגור, לא לדרוס בשקט.)
3. **מעבר:** עם הקריאה-הכפולה חיה, המאגר המאוחד עונה קודם. מאמתים על מדגם קריאות
   חיות (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) שהן עדיין
   נפתרות.
4. **אחרי המעבר:** `app_secrets` **לא נפרשת** — היא נשארת מאגר הגדרות הפר-
   אפליקציוני (שורות `is_secret = false`). רק שורות ה-סוד עוזבות אותה. לא חלק
   משלב 1.

---

## 5. `smrtvoice` — נשאר ראי-קריאה-בלבד (מאושר)

המפתחות `VOICE_ENGINE_URL`, `VOICE_ENGINE_API_KEY`, `VOICE_ENGINE_WEBHOOK_SECRET`
משותפים עם מנוע-הקול (Python, ריפו `voice-engine`) ב-Railway. עריכתם מכאן תנתק את
שני השירותים. לכן בתצוגה המאוחדת הם מוצגים **לקריאה בלבד** (set/missing), והעריכה
נשארת ב-Railway. זה משמר את ההתנהגות הקיימת (`ENV_PLATFORM_KEYS`, `routes.ts:232`).

---

## 6. שלבי גלגול

0. **שלב 0 — אפליקציית `smrtClaude`** (§3.5): קידום קונסולת Claude לאפליקציה מן-
   המניין (רשומת `APPS` + entitlement + מפת-הקוד). שלב עצמאי, נאשר היקף לפני
   scaffolding. יכול לרוץ במקביל לשלב 1.
1. **שלב 1 — מודל + backend (בלי מעבר UI):** הוספת `managed_secret_apps` (מיגרציה
   תוספתית אחת); הפיכת `getAppSecret` לקריאה-כפולה; endpoints לשיוך-אפליקציות. עדיין
   מאחורי המסך הקיים. **זה השלב הרגיש-לריצה** — פרוטוקול pre-push מלא + page-check.
2. **שלב 2 — UI תחת וואלט:** שלושת הטאבים תחת `/vault` עם הגיית super-admin; חלק
   שיוך-האפליקציות על `SecretCard`; העברת/הפניית `/admin/apps/<slug>/secrets`
   ו-`/admin/secrets` פנימה.
3. **שלב 3 — מיגרציית נתונים:** תצוגה-מקדימה → אישור → מילוי-לאחור → אימות.
4. **שלב 4 — ניקוי:** הפסקת כתיבת *סודות* ל-`app_secrets` (הגדרות נשאר בה).
   הטבלה **לא נפרשת** — היא ממשיכה כמאגר הגדרות הפר-אפליקציוני.

כל שלב ניתן לשילוח עצמאי והפיך.

---

## 7. סטטוס ההכרעות

| נושא | הכרעה |
|---|---|
| מיקום | **הכל תחת אפליקציית וואלט**, שלושה טאבים (§3) — ✅ מאושר |
| מפתחות הגדרות (`GEMINI_MODEL` וכו') | **נשארים פר-אפליקציה**, לא מאחדים — ✅ מאושר |
| `smrtvoice` לקריאה-בלבד | **נשאר ראי-קריאה-בלבד**, עריכה ב-Railway (§5) — ✅ לפי המלצה |
| חשבונות Claude | אפליקציה חדשה **`smrtClaude`** (§3.5); הטוקנים+ההגדרות עוברים אליה — ✅ מאושר |

מוכן להתחיל משלב 1 (מודל + backend) עם אישורך.
