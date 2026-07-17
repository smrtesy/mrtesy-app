# מודל ההרשאות של smrtesy — מפה, פערים, והצעת מודל

> מסמך עבודה. נכתב כדי להסכים על המודל **לפני** תיקון באג ההזמנה (באג 2).
> כל הציטוטים הם למצב הקוד הנוכחי ב-`claude/project-only-worker-setup-wvxmv5`.

## 1. אבני הבניין של ההרשאות (מה קיים היום)

יש שלוש שכבות בקרה בלתי-תלויות:

| שכבה | היכן | מה קובעת |
|---|---|---|
| **תפקיד בארגון** (`role`) | `org_members.role` ∈ `owner` / `admin` / `member`. אכיפה: `requireRole(...)` (`server/src/middleware/require-role.ts`) | "מנהל" = `owner` או `admin`. "עובד" = `member`. |
| **גישה לאפליקציה** (`requireApp`) | `require-app.ts:54`. הארגון מפעיל אפליקציה ב-`app_memberships`; עבור `member` נדרש בנוסף מענק אישי ב-`user_app_access` | האם המשתמש בכלל נכנס לאפליקציה. owner/admin — די בהפעלה ברמת הארגון; member — צריך מענק אישי. |
| **רמת גישה בתוך אפליקציה** (`full` / `lite`) | טבלה `app_user_access(org_id, app_id, user_id, access_level)`, `access_level ∈ ('full','lite')`. נוצרה ב-`supabase/migrations/20260604000100_smrtplan_schema.sql:38` | תת-דרגה בתוך אפליקציה. **כרגע רק smrtPlan קורא אותה.** |

**נקודה קריטית:** הטבלה `app_user_access` קיימת, אבל **אף פעם לא נכתבת** — אין UI או API שמגדיר למישהו `full`/`lite`. לכן ב-smrtPlan הרמה נקבעת כרגע *רק* לפי ברירת המחדל: owner/admin → `full`, member → `lite` (`smrtplan/routes.ts:275-289`). אין דרך להפוך member ל-`full` ב-smrtPlan, ואין דרך להשתמש במנגנון הזה ב-smrtTask.

---

## 2. מפת ההרשאות לכל אפליקציה (מצב נוכחי)

בכל טבלה: "עובד" = `member` שקיבל מענק לאפליקציה. "מנהל" = owner/admin.

### smrtTask — `server/src/modules/smrttask/`
כל ה-routes מאחורי `requireApp("smrttask")` בלבד. **כמעט אין בידול.**

| מה | עובד (member) | מנהל (owner/admin) |
|---|---|---|
| משימות: יצירה/עריכה/מחיקה/השלמה/דחייה/מיזוג/סידור | ✅ | ✅ |
| **הקצאת משימה למשתמש אחר** (`assigned_to_user_id`) | ❌ | ✅ בלבד (`tasks/routes.ts:643`) |
| פרויקטים: CRUD מלא + בניית brief + suggest | ✅ | ✅ |
| תזכורות, מרתון, day-plan, work-clock, router (AI) | ✅ | ✅ |
| מאגר ידע (knowledge): הוספה | ✅ אבל נכנס כ-`pending` | ✅ מאושר אוטומטית |
| מאגר ידע: עריכה/אישור/דחייה | ❌ | ✅ (`knowledge.ts:135,169,188`) |

- **היקף נתונים:** משימות/פרויקטים מסוננים לפי `organization_id`, **לא** לפי משתמש → כל עובד רואה ומעדכן את **כל** משימות הארגון. `assigned_to` ו-`mine=true` הם פילטרים אופציונליים בלבד, לא נאכפים (`routes.ts:235,251`).
- **חלקים שקשורים למקורות של המשתמש עצמו** (עובד בלי מקורות לא יראה בהם כלום): כל צינור ה-sync (Gmail/Drive/Calendar), inbox ומקור המשימות, agenda מהיומן, actions (טיוטות Gmail/אירועי יומן), WhatsApp/SMS, knowledge, corrections/style. משימות/פרויקטים/תזכורות **ידניים** הם היחידים שלא תלויי-מקור.
- **אין היום מושג של "עובד רזה"** שרואה רק משימות שהוקצו לו. אבני הבניין קיימות כנתונים (`assigned_to_user_id`, `plan_id`) אבל שום קוד לא אוכף תצוגה מוגבלת.

### smrtPlan — `server/src/modules/smrtplan/` (**היחיד עם full/lite**)
`requireApp("smrtplan")` + `requireFull` על כתיבה (`routes.ts:292`).

| מה | עובד = `lite` | מנהל / `full` |
|---|---|---|
| צפייה בתוכניות/לוח/מטריצה/משימות התוכנית | ✅ (כל הארגון, ללא סינון פרטיות) | ✅ |
| המשימות **שלי** בתוכנית, קבלה/דחיית שיבוץ, סימון done, reblock | ✅ (אם הוא ה-assignee) | ✅ |
| יצירה/עריכה/מחיקה של תוכניות; אישור draft (`status:'active'`) | ❌ | ✅ (`routes.ts:449,474,491`) |
| **RolesEditor** — הגדרת תפקידים והקצאת אנשים לתפקיד | ❌ | ✅ (`routes.ts:1505-1571`) |
| תבניות, AI-build, capacity/estimates, worker-tasks | ❌ | ✅ |

- **נתיב שיבוץ תוכנית → משימה:** `POST /plans/:id/tasks` יוצר שורה ב-`tasks` עם `plan_id` + `assigned_to_user_id` (assignee מפורש, או ה-primary של role דרך `smrtplan_role_members`). התבניות ו-AI-build משבצים לפי role primary. כך "עובד פרויקטים" מקבל משימות — הוא ה-assignee.
- **ראיית משימת-תוכנית** היא עניין של smrtTask (השורות ממוזגות ל-`/tasks`); מענק smrtplan נדרש רק לתצוגות ההקשר של התוכנית עצמה.

### smrtVoice — `server/src/modules/smrtvoice/` (**יש בידול אמיתי**)
`requireApp("smrtvoice")` + `requireRole("owner","admin")` על ~15 routes.

| מה | עובד | מנהל |
|---|---|---|
| כל תהליך ההפקה: יצירה/מחיקת פרויקטים וסקריפטים, parse, casting, **הפקת אודיו (עולה כסף)**, עריכת שורות/takes, לקסיקון הגייה, קריאת הגדרות/תקציב | ✅ | ✅ |
| יצירת/שכפול דמויות וקולות, ניהול חשבון Resemble, עריכת הגדרות/תקציב הארגון, ביטול סקריפט, פעולות שורה מרוכזות | ❌ | ✅ |

- **היקף נתונים:** כלל-ארגוני. כל עובד רואה/עורך את כל תוכן הארגון; `user_id` הוא רק attribution.

### smrtBot — `server/src/modules/smrtbot/` (**בידול per-bot**)
`requireApp("smrtbot")` + `requireBotAccess` (owner/admin עוברים תמיד; member צריך שורת `smrtbot_bot_access` לבוט הספציפי).

| מה | עובד | מנהל |
|---|---|---|
| קריאה/עריכה מלאה של בוט שיש לו גישה אליו (תוכן, publish/rollback, חיבור WhatsApp, broadcasts, מענה) | ✅ (רק לבוטים שהוקצו לו) | ✅ (כל הבוטים) |
| **יצירת בוט** | ❌ | ✅ (`bots.ts:117`) |
| **ניהול גישות לבוט** (הוספת/הסרת משתמשים) | ❌ | ✅ (`bots.ts:262-301`) |

- אין תת-דרגה של קריאה-בלבד בתוך בוט שהוקצה.

### smrtCRM — `server/src/modules/smrtcrm/` (**⚠ אין שום בידול**)
`requireApp("smrtcrm")` בלבד על כל route. אין `requireRole`. ההערה בקוד מצהירה במפורש: "הכל שווה — כולם יכולים הכל" (`routes.ts:7-10`).

| עובד + מנהל (זהה) |
|---|
| CRUD מלא של אנשי קשר, פעולות מרובות ("בחר הכל לפי פילטר"), תגים, סגמנטים, ייבוא CSV/Sheet עד 10K שורות, ניהול חיבורי API נכנס **כולל הנפקת טוקנים סודיים** |

→ **פער:** אין הרשאת מנהל נפרדת. עובד = הרשאות מלאות.

### smrtReach — `server/src/modules/smrtreach/` (**⚠ אין שום בידול**)
`requireApp("smrtreach")` בלבד. אין `requireRole`.

| עובד + מנהל (זהה) |
|---|
| CRUD קמפיינים, **שליחה חיה של קמפיין** (email/WhatsApp), **שליחה מיידית שעוקפת חלון שליחה/שבת/rate-limit**, ניהול שולחים/תבניות/הגדרות, מחיקת קמפיינים |

→ **פער:** פעולות רגישות מאוד (שליחה המונית) פתוחות לכל עובד עם המענק, בלי אישור מנהל.

### smrtVault — `server/src/modules/smrtvault/` (פרטי לכל משתמש)
`requireApp("smrtvault")` בלבד. כל query מסונן לפי `org_id` **וגם** `user_id` → כספת אישית לחלוטין. owner/admin **אינם** רואים סיסמאות של אחרים. אין בידול member/manager, וזה **תקין** לפי טבע האפליקציה.

### פלטפורמה (ניהול ארגון) — `server/src/modules/platform/`

| פעולה | מי |
|---|---|
| הזמנת/הוספת חבר, קביעת אפליקציות לחבר, placeholder, קביעת מייל/שם-תצוגה, ניהול הזמנות | owner/admin |
| שינוי **תפקיד** חבר | owner בלבד (`members/routes.ts:340`) |
| הפעלת/כיבוי אפליקציה לארגון (`/org/apps`) | owner בלבד (`apps.ts:37,59`) |
| עריכת פרטי הארגון | owner/admin |
| צפייה ברשימת חברים, `GET /org/me`, עזיבה עצמית | כל חבר |
| `/me/*` — הגדרות אישיות, חיבור מקורות, פוש | לכל משתמש מחובר (בלי org/role) |

---

## 3. סיכום הפערים

1. **smrtTask — אין "עובד רזה".** כל מי שיש לו smrtTask מקבל את האפליקציה המלאה (inbox, sync, כל משימות הארגון, פרויקטים, ידע). זה בדיוק מה שחסר לבקשה שלך.
2. **smrtCRM ו-smrtReach — אין בידול מנהל/עובד בכלל.** עובד יכול לשלוח קמפיין המוני / למחוק אנשי קשר / להנפיק טוקני API בדיוק כמו מנהל. אם רוצים "לכל אפליקציה עובד רגיל ומנהל" — כאן צריך להוסיף שכבת מנהל.
3. **`app_user_access` (full/lite) קיימת אך לא מחווטת.** אין UI שמגדיר אותה, ורק smrtPlan קורא אותה. זו התשתית הטבעית להרחבה.
4. **smrtPlan — אי-אפשר להפוך member ל-`full`** דרך ה-UI (המנגנון קיים בשרת אבל אין איפה לכתוב אותו).

---

## 4. הצעת מודל אחיד (לאישורך)

**שני צירים בלתי-תלויים:**

- **ציר א' — תפקיד בארגון:** מנהל (owner/admin) מול עובד (member). כבר קיים.
- **ציר ב' — רמת גישה לכל אפליקציה:** `full` מול `lite`, נשמר ב-`app_user_access` (הטבלה הקיימת). נחווט אותה סוף-סוף גם לכתיבה (ב-UI של ניהול החברים) וגם לקריאה בכל אפליקציה שבה יש הבדל.

**המשמעות ל-smrtTask (לב הבקשה שלך):**

| | `smrtTask: full` (משתמש מלא) | `smrtTask: lite` (עובד פרויקטים בלבד) |
|---|---|---|
| מקורות (Gmail/Drive/Calendar), inbox, sync, agenda, actions, ידע | ✅ | ❌ (מוסתר לחלוטין) |
| onboarding של חיבור מקורות + סריקה | ✅ | ❌ **מדולג לגמרי** |
| משימות שרואה | כל משימות הארגון | **רק משימות שהוקצו לו** — מתוכנית (`plan_id`+assignee) או ממשתמש אחר/מנהל (`assigned_to_user_id`) |
| יצירה/עריכה/השלמה של המשימות שלו | ✅ | ✅ (על המשימות שלו) |
| פרויקטים, brief, router, מרתון | ✅ | מוגבל/מוסתר (לפי החלטתך) |

זה מייצר בדיוק את "המשתמש הרזה" שתיארת: משתמש ב-smrtTask **רק** למשימות ששויכו אליו מפלאן או ממשתמשים אחרים, בלי כל צינור המקורות.

---

## 5. ההכרעות שהתקבלו

1. **מה עובד רזה רואה:** המשימות שלו בלבד **+ צפייה בתוכנית** (smrtPlan ברמת `lite`, קריאה בלבד).
2. **פרויקטים / router (AI) / מרתון / inbox / מקורות:** **מוסתרים לגמרי** לעובד רזה.
3. **smrtCRM / smrtReach:** לא נוגעים כרגע — מתמקדים ב-smrtTask בלבד. (הפער נשאר מתועד לעתיד.)
4. **אחסון הרמה:** נשתמש בטבלה הקיימת `app_user_access` (ציר full/lite), ונחווט אותה סוף-סוף גם לכתיבה. *(ממתין לאישורך הסופי — סעיף 7.)*

---

## 6. המודל שנבנה

**עובד רזה (project-only worker)** = חבר ארגון (`role='member'`) עם:
- מענק `user_app_access` ל-`smrttask` **וגם** `smrtplan`.
- שורת `app_user_access` שקובעת `smrttask = 'lite'` (smrtplan נשאר `lite` כברירת מחדל של member — צפייה בלבד, כפי שכבר קיים).

**עובד מלא** = חבר עם `smrttask` בלי שורת lite → נפתר ל-`full`.
> ⚠ שינוי ברירת מחדל חשוב: היום כל member עם smrttask מקבל את האפליקציה המלאה. כדי לא לשבור חברים קיימים, ברירת המחדל של member ב-smrtTask תישאר **`full`**; `lite` הוא opt-in מפורש בלבד (בניגוד ל-smrtplan שם member=lite כברירת מחדל).

מה עובד רזה יכול ב-smrtTask (`lite`):
- לראות **רק** משימות שבהן `assigned_to_user_id = הוא עצמו` (מפלאן דרך `plan_id`+assignee, או ממשתמש אחר/מנהל). אכיפה בשרת, לא פילטר אופציונלי.
- לעדכן/להשלים/להגיב-לשיבוץ על המשימות שלו.
- **לא** רואה: inbox, מקורות/sync, agenda מהיומן, actions, WhatsApp/SMS, פרויקטים, router, מרתון, knowledge.

---

## 7. הגדרת תיקון באג 2 + תוכנית מימוש

באג 2 הוא סימפטום של אותו חוסר: אין הבחנה בין "בעל ארגון שמחבר את המקורות של עצמו" לבין "עובד שהוזמן". התיקון = המודל של סעיף 6 + הסתעפות ב-onboarding.

### 7.1 מסד נתונים (מיגרציה אחת)
- `org_invites`: הוספת `access_level text NOT NULL DEFAULT 'full' CHECK (access_level IN ('full','lite'))`.
- עדכון `accept_my_invites()`: כשמקבלים הזמנה עם `access_level='lite'`, בנוסף להכנסת `user_app_access`, לזרוע שורת `app_user_access(smrttask,'lite')`. (idempotent, `ON CONFLICT DO NOTHING`.)

### 7.2 שרת (Express)
- **smrtTask:** להוסיף `resolveTaskAccessLevel(req)` (במקביל ל-smrtplan): שורת `app_user_access` מנצחת; אחרת **full** לכולם (שמירת התנהגות). ואז:
  - `GET /tasks` (ורשימות קשורות): כשהמשתמש `lite` — לכפות סינון `assigned_to_user_id = self` בשרת.
  - שער `requireFullTask` שמחזיר 403 ל-`lite` על: `/sync/*`, projects, router, marathon, knowledge (כתיבה), inbox/source-messages, events, actions, whatsapp, sms.
- **פלטפורמה — הזמנה:** `POST /org/members` ו-`/placeholder` יקבלו `access_level`; יעבירו אותו ל-`org_invites` (למשתמש חדש) או יזרעו `app_user_access` ישירות (למשתמש קיים/placeholder). כשמזמינים "עובד פרויקטים" — לכפות `role='member'`, `app_slugs=['smrttask','smrtplan']`, `access_level='lite'`.

### 7.3 Frontend
- **onboarding — לב התיקון:** בכניסה ל-`/onboarding`, אם למשתמש `smrttask=lite` (או שהוא member שהוזמן בלי מקורות) → לדלג על כל שלבי חיבור המקורות + מסך הסריקה. להציג מסך "ברוך הבא" קצר, לקבוע `onboarding_completed=true` **בלי** לקרוא ל-`/api/sync/part1`, ולנתב ל-`/tasks`. כך נעלמת גם שגיאת ההרשאה.
- **Sidebar / ניווט:** לעובד רזה להציג רק `tasks` (מקבוצת smrtTask) + קבוצת smrtPlan לצפייה; להסתיר inbox/whatsapp/sms/projects/knowledge.
- **מסך המשימות:** ברירת מחדל "המשימות שלי", בלי affordances של inbox/יצירת משימות ארגוניות.
- **UI ניהול חברים** (`OrgSettingsClient`): טוגל "עובד פרויקטים בלבד" בטופס ההזמנה — כשדולק, נועל role=member, מסתיר בורר אפליקציות ושולח את החבילה הרזה. בנוסף, אפשרות לשנות חבר קיים בין מלא/רזה (חיווט `app_user_access` דרך ה-UI).

### 7.4 תיקון מיידי ל-lw@maor.org
lw כבר member בארגון Maor בלי הרשאות ו-onboarding תקוע. שני מסלולים אפשריים:
- **א. להפוך אותו לעובד רזה עכשיו:** לזרוע `user_app_access(smrttask,smrtplan)` + `app_user_access(smrttask,'lite')`, ו-`onboarding_completed=true`. הוא נכנס מיד למסך המשימות שלו.
- **ב. לא לגעת ידנית:** אחרי שהפיצ'ר יעלה, לאפס לו onboarding ולהזמין מחדש כעובד רזה.

*(ההמלצה: א — הוא כבר תקוע, וזה מאמת את כל הזרימה מקצה לקצה. כתיבת DB ידנית תיעשה רק לאחר אישורך.)*

### 7.5 היקף/סדר עבודה מוצע
1. מיגרציה (7.1).
2. שרת: resolveTaskAccessLevel + שערים + סינון (7.2) + נתיב ההזמנה.
3. onboarding branch (7.3) — זה מה שסוגר את באג 2.
4. UI ניהול חברים + ניווט (7.3).
5. תיקון lw (7.4).
6. פרוטוקול ה-pre-push המלא לפני push.
