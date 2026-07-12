# smrtPlan × פוקוס יומי + בונה-תוכנית AI — מסמך אינטגרציה

מסמך הנדסי, יולי 2026. איך "כלי הפוקוס" (day-tools §8 ב-`day-tools-plan.md`)
משתלב ב-smrtPlan, וכל השינויים הנדרשים ברמת טבלה / route / קומפוננטה.
זה המסמך הצמוד ל-`day-tools-plan.md` — כאן הפירוט הטכני בצד smrtPlan.

מקורות המפה: `smrtplan-overview.md`, `smrtplan-roadmap.md`, וסריקת קוד
(יולי 2026). כל citation הוא file:line במצב הנוכחי.

---

## 0. תקציר מנהלים

מוסיפים ל-smrtPlan שלוש יכולות, שרובן **שכבה מעל** מה שקיים:

1. **התחייבות זמן יומית** לתוכנית (פר-אדם) — `smrtplan_focus`.
2. **בונה-תוכנית AI** — מתאר פרויקט → שלבים + אומדן שעות + חלוקה יומית +
   תאריך סיום משוער דו-לשוני + שיוך למקים. שני מסלולים: in-app ו-ייבוא.
3. **סשן פוקוס יומי** — טיימר יורד, "השלב הנוכחי", צליל + מסך חוסם;
   סיום שלב משחרר את הבא (מנוע קיים).

**לא נוגעים במנוע התזמון.** הוא ממשיך לתזמן אחורה מדדליין; "תאריך סיום
משוער" הוא הקרנה קדימה נפרדת (§4).

---

## 1. מה כבר קיים ומנוצל (reuse, אפס/מעט שינוי)

| יכולת | מיקום | הערה |
|---|---|---|
| משימות = טבלת `tasks` משותפת | `20260604000100_smrtplan_schema.sql:111-125` | `plan_id`, `stage_id`, `role_id`, `assigned_to_user_id` |
| אומדן שעות | `tasks.estimated_hours` (`20260604001200`) | קיים ב-DB, המנוע גוזר `duration_days` (`engine.ts:363-366`) — **אך אין קלט ב-UI** (§6) |
| מוכן/חסום/הושלם + סדר | `TaskZones.tsx:33-51` | לוגיקת לקוח; צריך הרמה ל-util (§5) |
| מסירה אוטומטית | `engine.ts:585 releaseDependents` דרך `on-task-completed.ts` | עובד מ-`/tasks/:id/complete` — **אפס שינוי** |
| אחראים + ברירת-מחדל תפקיד | `roleDefaultAssignee` (`routes.ts:244-259`) | שיוך-מחדש קיים ב-`PlanEffortDetail.tsx:547-560` |
| טיוטה שקטה | `status='draft'` + `silentPlanIds()` (`routes.ts:337-340`) | תוכנית AI נולדת draft |
| ימי-עסקים | `src/lib/workdays.ts` (mirror של `engine.ts:112-119`) | שני–שישי − חגים; דרך `/api/work-calendar` |
| יצירת תוכנית-מתבנית | `POST /api/plan/templates/:id/apply` (`routes.ts:1625-1709`) | יוצר effort draft + משימות + תלויות — התקדים לבונה-ה-AI |

---

## 2. שינויי דאטה (מיגרציות חדשות)

```sql
-- מיגרציה 1: התחייבות זמן יומית, פר-אדם-פר-תוכנית
CREATE TABLE smrtplan_focus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  plan_id       uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id),
  daily_minutes int  NOT NULL CHECK (daily_minutes > 0),
  active        bool NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, user_id)
);
-- + RLS: user_id = auth.uid() בקריאה/כתיבה, בגבולות org

-- מיגרציה 2: לוג סשן פוקוס יומי
CREATE TABLE focus_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  plan_id         uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  session_date    date NOT NULL,
  planned_minutes int  NOT NULL,
  actual_minutes  int  NOT NULL DEFAULT 0,
  tasks_completed int  NOT NULL DEFAULT 0,
  completed_full  bool NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
-- + RLS + INDEX (user_id, session_date)
```

-- מיגרציה 3: שדות תכנון על משימות (בונה-התוכנית + מחקר + הפצת החלטות)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS definition_of_done text,            -- "מבחן הזר"
  ADD COLUMN IF NOT EXISTS ai_tier  text CHECK (ai_tier IN ('full','assist','human')),
  ADD COLUMN IF NOT EXISTS ai_prompt text,                     -- פרומפט-פתיחה מוכן
  ADD COLUMN IF NOT EXISTS is_decision bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS affected_by uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS external_wait_days int NOT NULL DEFAULT 0;  -- המתנה חיצונית (תחנה 8)
-- (stages: ל-smrtplan_stages אפשר להוסיף checkpoint text לנקודת-הביקורת)
```

- `estimated_hours` כבר קיים; אחראים/תלויות/מסירה/טיוטה קיימים. **חדש**
  על `tasks`: שדות התכנון של הפרוטוקול (מיגרציה 3 מעלה) — הבונה ממלא
  אותם, והם מוצגים במשימה (DoD, תג AI, פרומפט מוכן) ומשמשים את הפצת
  ההחלטות (§10).
- **משימות מחקר (מהדורה 2 של הפרוטוקול) — מכוסות במלואן ללא סכמה
  נוספת.** מיפוי הפרוטוקול (§13, טבלת "מיפוי משימות מחקר"): ספייק →
  `is_decision=true`; תזכיר החלטה → `definition_of_done`; שאלה/
  קריטריונים/משקלים/סף/תקציב-סשנים → `description`; קריטריון-סיום/שלבי-
  בדיקה → `checklist`; פרומפט הרתמה → `ai_prompt`; תקציב-סשנים →
  `estimated_hours`. כל השדות האלה קיימים (מיגרציה 3 + קיימים).
- **`external_wait_days`** (חדש) — לוכד את "ההמתנות שלא שורפות סשנים"
  (רינדורים/תורים/ספקים) של תחנה 8; ההקרנה מציגה אותו בנפרד (§4).
- `day_tools.planfocus = { enabled }` — מפתח ברג'יסטרי (עמודת ה-JSONB
  של day-tools, בלי מיגרציה נוספת). ראה `day-tools-plan.md §2.1`.

> **מקור הסכמה הקנוני** של ה-payload לבנייה/ייבוא הוא
> `project-planning-protocol.md §13`. שדות ה-JSON שם ממופים לעמודות:
> `definition_of_done`/`ai_tier`/`ai_prompt`/`is_decision`/`affected_by`
> (חדשים), `estimated_hours`/`assignee`/`depends_on`/`checklist`
> (קיימים), ו-`stage`→`stage_id`. מפתחות `key` ב-JSON נפתרים ל-uuid
> בזמן היצירה (למיפוי `depends_on`/`affected_by`).

---

## 3. שינויי API (server/src/modules/smrtplan/routes.ts)

**חדש:**
- `GET  /plan/:id/focus-stage` — המשימה המוכנה הראשונה שלי בתוכנית
  (השלב הנוכחי). נשען על util מ-§5.
- `GET  /plan/focus-today` — תוכניותיי עם `smrtplan_focus.active` +
  השלב הנוכחי + האם `focus_sessions` נכתב היום (למען שורת-הבלוק ב-/tasks).
- `GET  /plan/:id/projection` — תאריך סיום משוער (§4).
- `PUT  /plan/:id/focus` — קביעת/עדכון ההתחייבות היומית (upsert
  `smrtplan_focus` פר-משתמש).
- `POST /focus-sessions` + `PATCH /focus-sessions/:id` — פתיחת/סגירת סשן.
- **בונה-תוכנית AI:**
  - `POST /plans/ai-build` — מסלול in-app: מקבל תיאור + daily_minutes,
    קורא ל-Anthropic (Sonnet), מחזיר **הצעה** (שלבים + estimated_hours +
    חלוקה + תאריך משוער) — **בלי לכתוב** עד אישור.
  - `POST /plans/ai-build/commit` — יוצר תוכנית `draft` + משימות
    (`estimated_hours`, `assigned_to_user_id=creator`) + `smrtplan_focus`.
  - `POST /plans/import` — מסלול ייבוא (קלוד קוד): אותו סכמת-הצעה, יוצר
    ישירות. שני המסלולים כותבים לאותו מבנה.
  - **payload של `ai-build/commit` ו-`import` = `project-planning-protocol.md
    §11`** (קנוני). שניהם ממפים את *כל* שדות התכנון (§2 מיגרציה 3),
    כולל `is_decision`/`affected_by` ו-`ai_tier`/`ai_prompt`, ופותרים
    `key`→uuid.

**ללא שינוי (מנוצל כמו שהוא):**
- `POST /plans` (`:446`), `POST /plans/:id/tasks` (`:983` — כבר מקבל
  `estimated_hours`), `/tasks/:id/complete`, `/plan-tasks/:id/done`,
  `PATCH /plan-tasks/:id` (שיוך-מחדש).

> באג קדים שהתגלה (לא חלק מהעבודה, לתיעוד): `POST /plans` דוחה `kind='roster'`
> (`routes.ts:451-453`) למרות שה-UI מציע אותו. לא חוסם אותנו (אנחנו יוצרים
> `effort`), אבל שווה תיקון בהזדמנות.

---

## 4. תאריך סיום משוער — הקרנה קדימה (לא המנוע)

```
שעות שנותרו = Σ estimated_hours של משימות התוכנית שטרם הושלמו
עם באפר     = שעות שנותרו × (1 + BUFFER)          // BUFFER = 0.20 (פרוטוקול §12)
ימי-עבודה   = ceil( עם-באפר ÷ (daily_minutes ÷ 60) )
תאריך סיום  = addWorkdays(today, ימי-עבודה, blocked)   // src/lib/workdays.ts
```

- **הבאפר (20%) מוחל גם כאן**, לא רק בזמן התכנון — כדי שההקרנה החיה
  תיתן את אותו תאריך שהבונה הציג. הפקטור משותף עם `project-planning-
  protocol.md §12`.
- **המתנות חיצוניות מוצגות בנפרד** (תחנה 8): `Σ external_wait_days`
  מוצג כשורה נפרדת ("+ ~N ימי המתנה חיצונית — רינדורים/ספקים") ולא
  מקופל לתאריך הפוקוס, כי הוא רץ ברקע ולרוב חופף לסשנים. לתאריך
  קלנדרי מדויק כשההמתנה על המסלול הקריטי — המנוע (`duration_days`)
  נשאר הסמכות (תזמון עם תלויות/דדליין).
- דו-לשוני: פורמט התאריך דרך ה-locale הקיים (he/en).
- **מקבילי למנוע, לא מזין אותו.** תוכנית בלי דדליין → זה התאריך הראשי.
  תוכנית עם דדליין → מוצג לצד הערכת-הסיכון של המנוע ("בקצב הזה תגיע/לא").
- מקום החישוב: `GET /plan/:id/projection` (שרת) — כדי שגם הבונה וגם מסך
  התוכנית יראו אותו מספר.

---

## 5. הרמת לוגיקת מוכן/חסום ל-util משותף

היום החלוקה מוכן/חסום/הושלם + הסדר יושבת ב-`TaskZones.tsx:33-51` (לקוח
בלבד). כדי שמסך הפוקוס, שורת-הבלוק ו-`focus-stage` יקראו אותו דבר:

- להוציא ל-util משותף (למשל `src/lib/smrtplan/zones.ts`): `zoneOf(task)`
  (`needs.satisfied` → done/blocked/ready) ו-`byUrgency` (סדר לפי
  `effectiveDeadline`).
- `TaskZones.tsx` צורך את ה-util (בלי שינוי התנהגות).
- `GET /plan/:id/focus-stage` מריץ את אותה לוגיקה בשרת (על תוצאת
  `attachNeedsHandoff`, `routes.ts:99`).

---

## 6. שינויי UI — איפה בדיוק

| מסך | קובץ | שינוי |
|---|---|---|
| **בונה-תוכנית AI** | חדש: `PlanAiBuilder.tsx` | נקודת כניסה מהלוח (ליד "תוכנית חדשה", `PlanBoardClient.tsx:772`); זרימת תיאור→הצעה→אישור |
| **דיאלוג תוכנית** | `PlanEditDialog.tsx` | שדה **התחייבות יומית (דקות)** — `PUT /plan/:id/focus` |
| **פרטי תוכנית** | `PlanEffortDetail.tsx` | קלט **`estimated_hours` פר-משימה** (היום אין! רק `duration_days` ב-`NewTaskRow:721`/`EditTaskRow:876`); הצגת `definition_of_done` + תג `ai_tier` + כפתור העתקת `ai_prompt`; סימון משימת-החלטה; תג "תאריך סיום משוער"; שיוך-מחדש כבר קיים (`:547-560`) |
| **דף המשימות** | `src/components/smrttask/tasks/TaskList.tsx` | שורת-בלוק פוקוס (⏱ NN ▶) מ-`GET /plan/focus-today` |
| **מסך סשן פוקוס** | חדש: `FocusSession.tsx` | פורק של `MarathonMode.tsx` — count-down, שלב נוכחי, צליל+חסימה |
| **הגדרות כלי-היום** | סקשן "כלי היום" | טוגל `planfocus` |

---

## 7. הגדרת פרויקט — חדש מול קיים, איפה בדיוק (התשובה המלאה)

### פרויקט חדש (אחרי השינוי) — שני מסלולים

**מסלול A — בונה-תוכנית AI (החדש, המומלץ):**
1. בלוח (`PlanBoardClient.tsx`), ליד "תוכנית חדשה" (`:772`) — כפתור
   **"בנה תוכנית עם AI"** → פותח `PlanAiBuilder.tsx` (חדש).
2. המשתמש כותב תיאור חופשי + **דקות-ליום**.
3. `POST /plans/ai-build` → Anthropic (Sonnet) → **הצעה**: שלבים,
   `estimated_hours` לכל שלב, חלוקה יומית, **תאריך סיום משוער דו-לשוני**.
4. המשתמש עובר על הרשימה, משייך שלבים לצוות (dropdown קיים בסגנון
   `PlanEffortDetail`), מאשר.
5. `POST /plans/ai-build/commit` → יוצר תוכנית **`draft`** (`POST /plans`
   פנימי), משימות (`POST /plans/:id/tasks` עם `estimated_hours` +
   `assigned_to_user_id=creator`), ו-`smrtplan_focus` (ההתחייבות).
6. אישור → `status='active'` → מופיע לצוות ובלוק-הפוקוס ב-/tasks.

**מסלול B — ידני קלאסי (קיים, נשאר):**
- "תוכנית חדשה" (`:772`) → `PlanEditDialog.tsx` → `POST /plans` → ואז
  משימות ב-`PlanEffortDetail.tsx` (`+ task` → `POST /plans/:id/tasks`).
- החדש כאן: שדה דקות-ביום בדיאלוג + קלט `estimated_hours` פר-משימה.

**מסלול C — ייבוא מקלוד קוד:** `POST /plans/import` עם אותה סכמת-הצעה.

### פרויקט קיים (אחרי השינוי)

1. לחיצה על התוכנית בלוח (`PlanBoardClient.tsx:895` → panel `:1338`) →
   `PlanEffortDetail.tsx`.
2. **קביעת התחייבות יומית:** שדה חדש (בדיאלוג העריכה או בראש הפרטים) →
   `PUT /plan/:id/focus`.
3. **מילוי `estimated_hours`** למשימות קיימות (קלט UI חדש) — נדרש כדי
   שההקרנה תעבוד; לחלופין להריץ את בונה-ה-AI על תוכנית קיימת שיציע
   אומדנים לשלבים שאין להם.
4. מרגע שיש `smrtplan_focus.active` — התוכנית מופיעה אוטומטית כבלוק
   ב-/tasks כל יום, ו-`GET /plan/:id/projection` נותן תאריך סיום.

---

## 8. מה שבמפורש לא משתנה

- **מנוע התזמון** (`engine.ts`) — אחורה מדדליין, מסלול קריטי, בריאות.
  דקות-הפוקוס לא נכנסות אליו.
- **מסירה/תלויות/אחראים/טיוטה** — כמו שהם.
- **סטטוסים, RLS, org-scoping** — ללא שינוי מבני.

---

## 9. שלבי ביצוע (צד smrtPlan)

1. **תשתית:** מיגרציות `smrtplan_focus` + `focus_sessions` + **מיגרציה 3**
   (שדות התכנון/מחקר + `external_wait_days`) + RLS; הרמת
   `zoneOf`/`byUrgency` ל-util משותף (§5).
2. **התחייבות + הקרנה:** `PUT /plan/:id/focus`, `GET /plan/:id/projection`,
   `GET /plan/focus-today`, `GET /plan/:id/focus-stage`; קלט
   `estimated_hours` + שדה דקות-ביום ב-UI (§6).
3. **בונה-תוכנית AI:** `POST /plans/ai-build(/commit)` + `PlanAiBuilder.tsx`;
   מסלול `POST /plans/import`.
4. **מסך פוקוס + הצטרפות ליום:** `FocusSession.tsx`, שורת-בלוק ב-`TaskList`,
   `focus-sessions` routes, טוגל `planfocus`.
5. **הפצת החלטות (§10):** שדות התכנון כבר במיגרציה 3; שדה-החלטה בדיאלוג
   ההשלמה; handler ל-`task.completed` שמצמיד עדכון למושפעים; מעבר ה-AI
   לאישור. שלב זה תלוי בבונה (שממלא `is_decision`/`affected_by`).

כל שלב עצמאי, כפוף לפרוטוקול ה-pre-push המלא (build + greps + תת-סוכן).

## 10. הפצת החלטות — תמיכת מערכת נדרשת ("תוכנית חיה")

הפרוטוקול (`project-planning-protocol.md` §10, תחנה 9) מגדיר משימות-החלטה
שתוצאתן זורמת קדימה למשימות מושפעות. תמיכה נדרשת:

- **דאטה:** `tasks.is_decision` + `tasks.affected_by` — כבר בתוך
  מיגרציה 3 (§2). הייבוא ממפה אותם מה-JSON (`key` → uuid).
- **רובד 1 (מכני):** בהשלמת משימה עם `is_decision=true` — המערכת
  מבקשת את ההחלטה במשפט (שדה בדיאלוג ההשלמה), ומצמידה אותה כעדכון
  בולט (`updates[]` הקיים) לכל המשימות שמכילות אותה ב-`affected_by`.
  מנגנון event קיים (`task.completed` → handler, כמו המסירה).
- **רובד 2 (AI, לאישור):** קריאת AI אחת מקבלת את ההחלטה + המשימות
  המושפעות ומציעה נוסח מעודכן (תיאור/checklist/אומדן). ההצעות
  ממתינות לאישור — לא נכתבות אוטומטית.

## 11. פתוחים / לשים לב

- **קלט `estimated_hours` ב-UI חסר לגמרי היום** — בונה-ה-AI הוא הצרכן
  הראשון; לתוכניות קיימות צריך קלט ידני או הרצת-AI.
- **באג `kind='roster'`** ב-`POST /plans` (§3) — לא חוסם, לתיקון עתידי.
- **ראשון = יום חופש** (שני–שישי) חל גם על ההקרנה האישית — החלטה פתוחה
  ב-`day-tools-plan.md §8.3a`.
- **מהדורה 2 של הפרוטוקול** (מסלול מחקר + מינוף AI) נבדקה: כל
  משימות המחקר, הספייקים, הבייק-אוף והרתמה **מכוסים בייבוא** ללא סכמה
  נוספת (§2, מיפוי §13). התוספת היחידה שנדרשה — `external_wait_days`
  (המתנות שלא שורפות סשנים).
- `stages.checkpoint` — נקודת-הביקורת של שלב (סכמת §13). לא קיים
  ב-`smrtplan_stages` היום; או עמודה חדשה או קיפול לתיאור השלב.
- **`manager_user_id`** על `smrtplan_plans` — בשימוש ב-routes אך ה-DDL
  לא אותר בסריקה; לוודא שקיים לפני שנשענים עליו.
