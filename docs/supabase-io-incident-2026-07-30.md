# תקלת 504 / Disk IO ב-Supabase — ממצאים והמלצות

**תאריך:** 30/07/2026, ~15:00 ניו יורק · **פרויקט:** Smrtesy (`exjnlghuzuvqedlltztz`)
· **חומרה:** האתר מתנדנד — נטען בשניות רגועות, נופל ל-`504 MIDDLEWARE_INVOCATION_TIMEOUT` בגלים.

---

## תשובות לשלוש השאלות (TL;DR)

1. **האם צמצום נכון פותר לטווח ארוך?** — **כן.** הבעיה היא **חוסר-יעילות**, לא נפח.
   מסד הנתונים קטן (22K הודעות, 1,645 משימות). מה ששורף IO הוא סריקות-טבלה
   מיותרות (אינדקסים חסרים), Realtime על טבלאות שאף אחד לא מאזין להן, ו-bloat.
   תיקון השורש נותן מרווח גדול — לא רק דוחה את הבעיה.
2. **האם זה משפיע על פעילות כלשהי?** — **לא**, לכל הצעדים המומלצים למטה (כל אחד
   אומת מול הקוד). היוצא-דופן היחיד הוא **הורדת תדירות cron**, שכן יש לה
   trade-off תפקודי — ולכן היא מסומנת "לא נדרש / מוצא אחרון".
3. **מי הצרכנים הגדולים?** — ראה הטבלה למטה. לפי סדר: Realtime, לולאות polling
   על `source_messages`, ו-bloat של pg_net.

**המלצה מיידית:** קח את **שדרוג ה-MICRO החינמי** (2 ליבות + תקציב IO גבוה יותר) —
מרים אותך מיד. השדרוג הוא תקרה גבוהה יותר; הצמצומים למטה הם הריפוי. עושים את שניהם.

---

## שרשרת הגורם

`Disk IO Budget` של Supabase נגמר (אישור: אימייל Supabase + באנר "exhausting multiple
resources" בדשבורד). כשהתקציב נגמר: זמני תגובה מזנקים → CPU עולה ב-IO-wait →
ה-instance לא-מגיב. אז:

- הקריאה `supabase.auth.getUser()` ב-`src/middleware.ts:81` (רצה על כל בקשה של
  משתמש מחובר) לא מצליחה להגיע ל-DB → ה-middleware חורג מזמן → Vercel מחזיר
  `504 MIDDLEWARE_INVOCATION_TIMEOUT` על העמוד/pane.
- בקשות אנונימיות לא נפגעות — `getUser()` בלי טוקן לא נוגע ב-DB (לכן דף הבית
  עולה אבל הנתונים לא).
- אישור חי: גם שאילתות אבחון ישירות שלי נכשלו שוב ושוב ב-`Connection terminated
  due to connection timeout` / `ECONNRESET`, והלוגים מלאים ב-`could not accept SSL
  connection: EOF detected`, `statement timeout`, `cron job startup timeout`.

---

## הצרכנים הגדולים (מ-`pg_stat_statements`, מדורג לפי זמן-ריצה מצטבר)

| # | צרכן | עדות | מקור |
|---|---|---|---|
| 1 | **Realtime — פענוח WAL** | `realtime.list_changes`: ~3.0M + 1.0M קריאות, ‎~22,370s + 6,203s מצטבר | Supabase Realtime מפענח את ה-replication slot ללא הרף |
| 2 | **polling על `source_messages`** | 3 שאילתות: 24,319 · 6,552 · 12,888 קריאות, ‎775–1,858ms כל אחת | `batch-details` (cron כל 3 דק') + `project-detection` — **אינדקס חסר** |
| 3 | **pg_net churn** | ניקוי `net._http_response`: 448K קריאות ‎~7,020s; `net.http_post`: 318K קריאות ‎~6,187s; הטבלה נפוחה ל-**58MB עם 0 שורות** | cron שיורה HTTP כל דקה |
| 4 | **טבלאות debug/log עתירות-כתיבה** | `whatsapp_webhook_debug` 13MB, `smrtbot_webhook_debug`, `log_entries` 19MB — כתיבה מייצרת WAL שגם Realtime חייב לפענח | ראה למטה |

`source_messages` ספגה **246,342 seq-scans** — למרות 10 אינדקסים קיימים, אף אחד
לא מכסה את דפוס ה-polling (`body_text IS NULL` + `source_type`, בלי `user_id` מוביל).

---

## תוכנית הצמצום — כל צעד + השפעה תפקודית (אומת מול הקוד)

| צעד | מה עושים | IO שנחסך | השפעה תפקודית | הפיך? |
|---|---|---|---|---|
| **A. אינדקס ל-`source_messages`** | `CREATE INDEX idx_source_messages_needs_body ON source_messages (source_type, created_at) WHERE body_text IS NULL;` | גדול — מבטל את סריקות ה-`batch-details` כל 3 דק' | **אפס** — שינוי planner בלבד | כן (DROP) |
| **A2. אינדקס ל-project-detection** (אופ') | `... (user_id) WHERE needs_project_check = true` | בינוני | **אפס** | כן |
| **B. הסרת 3 טבלאות מ-Realtime** | הסר `smrtvoice_jobs`, `smrtvoice_projects`, `smrtvoice_line_takes` מ-`supabase_realtime` | בינוני | **אפס** — אף לקוח לא מאזין להן (אומת ב-`src/`) | כן (הוסף בחזרה) |
| **C. ניקוי bloat של pg_net** | `VACUUM FULL net._http_response;` + לוודא retention של pg_net | מיידי — משחרר 58MB | **אפס** — לוג-תגובות פנימי | לא רלוונטי |
| **D. retention ל-`whatsapp_webhook_debug`** | cron מחיקה + לשקול להפסיק כתיבה | בינוני-נמוך | **אפס** — אף אחד לא קורא ממנה (INSERT יחיד ב-`route.ts:344`) | כן |
| **E. retention ל-`log_entries`** | מחיקת שורות ישנות `level NOT IN ('error')` מעל 30 יום | נמוך-בינוני | **אפס** אם שומרים error — הדוח היומי תלוי בהן | כן |
| **F. retention ל-`smrtbot_webhook_debug`** | cron מחיקה לפי גיל (7–30 יום) | נמוך | בטוח **אם שומרים אחרונות** — לשונית "Webhook log" קוראת ממנה | כן |
| **G. הורדת תדירות cron** (מוצא אחרון) | `search-index-drain` / `smrtreach-process-queue` / `smrtbot-broadcasts` רצים כל דקה | בינוני | **יש trade-off** — פוגע ברעננות חיפוש / latency תור. לא לגעת אלא אם A–F לא הספיקו | כן |

**הכי משתלם קודם:** A + B + C. שלושתם אפס-השפעה ותופסים את הצרכנים הגדולים.

---

## למה זה מחזיק לטווח ארוך

הצרכנים הגדולים הם **אינפרה לא-יעילה**, לא גדילת-נתונים:

- אינדקס (A) הוא תיקון **מבני חד-פעמי** — הסריקות נעלמות לתמיד.
- הסרת Realtime לא-בשימוש (B) מורידה תקורה **קבועה**.
- ניקוי bloat (C) משחרר נפח פעם אחת; retention (D/E/F) מונע הצטברות חוזרת.

**סייג כן:** אם נפח ההודעות או מספר המשתמשים יגדל דרמטית, ה-IO יגדל איתו. אבל
היום הבעיה היא בזבוז, לא קנה-מידה — ותיקון הבזבוז + שדרוג MICRO החינמי נותנים
מרווח גדול. שווה לעקוב אחרי מסך ה-Disk IO בדשבורד אחרי היישום.

---

## סדר פעולות מומלץ

1. **עכשיו:** שדרוג MICRO החינמי (הקלה מיידית, חינם).
2. **צעד A + B + C** (אפס-השפעה, הצרכנים הגדולים) — כמיגרציה + פקודה.
3. **צעד D + E + F** (retention crons) — מונע הישנות.
4. **מעקב:** מסך Disk IO בדשבורד; רק אם עדיין גבוה — לשקול G.
