# תוכנית תיקון — 14 ממצאי `auth_rls_initplan` (ביצועי RLS)

> נכתב 2026-08-07. מקור הממצאים: Supabase Advisors → Performance (WARN).
> סטטוס: **ממתין לאישור להחלה.** קובץ המיגרציה מוכן; לא הוחל על הפרודקשן.

## מה הבעיה (ולמה זו לא בעיית אבטחה)

14 מדיניות RLS על 9 טבלאות קוראות `auth.uid()` (או `current_setting()`)
**ישירות בתנאי ה-`USING`/`WITH CHECK`**. Postgres מריץ פונקציה כזו **מחדש לכל
שורה** שהמדיניות נבחנת עליה. בטבלה עם הרבה שורות זה עלול להכפיל את זמן השאילתה
פי כמה — היועץ מסמן זאת כ-`auth_rls_initplan`.

**זו בעיית ביצועים בלבד — לא חור אבטחה.** ההרשאות עצמן נכונות; הן פשוט
מחושבות לא-יעיל.

## התיקון (המומלץ הרשמי של Supabase)

לעטוף כל קריאה ל-`auth.<fn>()` ב-תת-שאילתה:

```
auth.uid()            →   (select auth.uid())
```

הפלאנר מזהה `(select auth.uid())` כ-**InitPlan** — מחשב אותו **פעם אחת**
בתחילת השאילתה ומטמין את הערך, במקום לכל שורה. **הערך המוחזר זהה לחלוטין**,
לכן:

- **אין שינוי סמנטי** — אותן שורות בדיוק מותרות/נחסמות, לפני ואחרי.
- **אין שינוי אבטחה** — גבול ההרשאות לא זז במילימטר.
- **אין נגיעה בנתונים** — משנים הגדרת-מדיניות, לא שורות.

מקור: [Supabase RLS — Call functions with `select`](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select).

## שיטת ההחלה — `ALTER POLICY`, לא DROP+CREATE

משתמשים ב-`ALTER POLICY ... USING (...) [WITH CHECK (...)]` שמשנה **רק את
הביטוי**, ומשאיר `cmd` ו-`TO <role>` כמו שהם. יתרון על DROP+CREATE: אין רגע
ביניים שבו המדיניות לא קיימת (חלון חשיפה), ואי-אפשר לשכוח לשחזר את הרול.

## 14 השינויים המדויקים

כל שורה: הביטוי כפי שהוא היום ← הביטוי אחרי (רק העטיפה השתנתה).

| # | טבלה | מדיניות | cmd | שינוי |
|---|---|---|---|---|
| 1 | `smrtdesign_projects` | `smrtdesign_projects_org_members` | ALL | `user_id = auth.uid()` בתת-שאילתת `org_members` ← `(select auth.uid())` · גם USING וגם WITH CHECK |
| 2 | `smrtdesign_options` | `smrtdesign_options_org_members` | ALL | כנ"ל · USING + WITH CHECK |
| 3 | `smrtdesign_selections` | `smrtdesign_selections_org_members` | ALL | כנ"ל · USING + WITH CHECK |
| 4 | `drive_catalog` | `drive_catalog_owner_select` | SELECT | `auth.uid() = user_id` ← `(select auth.uid()) = user_id` |
| 5 | `drive_catalog_scans` | `drive_catalog_scans_owner_select` | SELECT | כנ"ל |
| 6 | `org_restrictions` | `org_restrictions_select_members` | SELECT | `org_members.user_id = auth.uid()` ← `(select auth.uid())` |
| 7 | `org_restrictions` | `org_restrictions_super_admins` | ALL | `auth.uid() IN (SELECT user_id FROM super_admins)` ← `(select auth.uid()) IN (...)` |
| 8 | `user_resource_grants` | `user_resource_grants_select_self` | SELECT | `user_id = auth.uid()` ← `(select auth.uid())` |
| 9 | `user_resource_grants` | `user_resource_grants_select_admins` | SELECT | `org_members.user_id = auth.uid()` (+ בדיקת role) ← `(select auth.uid())` |
| 10 | `user_resource_grants` | `user_resource_grants_super_admins` | ALL | `auth.uid() IN (SELECT user_id FROM super_admins)` ← `(select auth.uid())` |
| 11 | `permission_audit_log` | `permission_audit_log_select_admins` | SELECT | `org_members.user_id = auth.uid()` (+ בדיקת role) ← `(select auth.uid())` |
| 12 | `permission_audit_log` | `permission_audit_log_super_admins` | ALL | `auth.uid() IN (SELECT user_id FROM super_admins)` ← `(select auth.uid())` |
| 13 | `classifier_golden_set` | `classifier_golden_set_owner` | ALL | `user_id = auth.uid()` ← `(select auth.uid())` · USING + WITH CHECK |
| 14 | `search_documents` | `search_documents_read` | SELECT | `... OR (user_id = auth.uid())` ← `(select auth.uid())` |

## אימות אחרי ההחלה

1. **הרצה חוזרת של היועץ** → 14 ממצאי `auth_rls_initplan` צריכים לרדת ל-0.
2. **בדיקת שקילות** — לכל טבלה, השוואת `qual`/`with_check` ב-`pg_policies`:
   ההבדל היחיד מול המצב הקודם הוא `(select auth.uid())` במקום `auth.uid()`.
3. **בדיקת התנהגות אמיתית** — קריאת שורה כמשתמש רגיל דרך ה-API (`SELECT` על
   `smrtdesign_projects` / `drive_catalog`) עדיין מחזירה בדיוק את שורות הארגון
   שלו, ולא שורות של ארגון אחר.

## שחזור (rollback)

הפיך לחלוטין — `ALTER POLICY` חוזר לביטוי המקורי (בלי העטיפה). קובץ המיגרציה
המקורי שיצר את כל מדיניות נשמר בהיסטוריה, אז שחזור = הרצת הביטוי הישן.

## מה זה **לא** מכסה

- `multiple_permissive_policies` (48) — נושא נפרד (איחוד מדיניות כפולות),
  לא מטופל כאן.
- `rls_enabled_no_policy` (38) — טבלאות עם RLS דלוק בלי מדיניות; נפרד.
- `pgaudit`/`extension_in_public` — העברת אקסטנשן, פעולה מסוכנת נפרדת.
