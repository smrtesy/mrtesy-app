# צ'קליסט Feature Parity: botsite → smrtBot / smrtCRM / smrtReach

> ערבות אי-אובדן פיצ'רים. כל פיצ'ר קיים ב-botsite מתועד כאן, ממופה לאפליקציית
> היעד, עם תיבת סימון לסטטוס מימוש. **אף תיבה לא נסגרת עד שהפיצ'ר עובד ביעד.**
> מיפוי נגזר מסריקה ממצה של הקוד (2026-06-03). `[ ]` = טרם · `[~]` = בבנייה · `[x]` = הושלם ואומת.

מקרא יעד: **B**=smrtBot · **C**=smrtCRM · **R**=smrtReach · **?**=לתכרעה.

---

## 1. ניהול בוט וקונפיגורציה — [B]
- [ ] יצירת בוט (שם, slug, initials, לוגו PNG/JPG/SVG ≤2MB)
- [ ] פרטי וואטסאפ test + live נפרדים (phone_number_id/access_token) + fallback legacy
- [ ] WABA ID (לניהול תבניות)
- [ ] אזור זמן per-bot (scheduler/תצוגה)
- [ ] רשימת טלפוני אדמין
- [ ] מפתח OpenAI per-bot → **מוחלף ב-Gemini ברמת הפלטפורמה**
- [ ] verify_token לוובהוק
- [ ] העלאת/ניהול לוגו → **Supabase Storage**
- [ ] טוגלים בהגדרות: automation_status (OFF/ON/test), test_phone, openai_enabled/model, diamonds_per_raffle_ticket, daily_reset_hour, post_interaction_delay, share_link_base, trivia_daily_limit
- [ ] `sheet_url` → **מבוטל** אחרי הגירת וידאו ל-`smrtbot_videos`

## 2. מנוע השיחה (Webhook) — [B]
- [ ] ניווט עץ תפריטים (node_key, label, type, body_text, buttons, parent_key, sort_order)
- [ ] טיפול בכפתורים (עד 3, ניווט ליעד)
- [ ] רשימות WhatsApp עם pagination
- [ ] זיהוי root node חכם (main/main_welcome/main_menu/parent-less)
- [ ] דה-דופליקציה של הודעות (חלון 60ש')
- [ ] debounce וובהוק (2ש' בין הודעות מאותו טלפון)
- [ ] ניהול state per-phone (cache, ניקוי אחרי 4 שעות)
- [ ] רשימות וידאו לפי קטגוריה/תת-קטגוריה/חג/רבי ← **מ-`smrtbot_videos`**
- [ ] תוכן מודע-חגים עם אימוג'י
- [ ] חיפוש / Smart-FAQ (keyword + fallback ל-**Gemini**)
- [ ] טיפול בתמונות (image_url, image_mode)
- [ ] השהיית פוסט-אינטראקציה (post_interaction_delay)
- [ ] auto-sync לאנשי קשר באינטראקציה ראשונה → **זרימה B→C**

## 3. מנגנון משחק — [B]
**ילדים/שחקנים**
- [ ] רישום מרובה-ילדים per-phone (child_id, child_name, hebrew_birthday, reminder_time, active_reminders)
- [ ] מעקב יום-הולדת עברי + תזכורות
- [ ] עריכת פרופיל ילד (ולידציית שם/תאריך)
- [ ] תזכורת יומית per-child (8-21), הפעלה/כיבוי

**יהלומים**
- [ ] ספר יהלומים (earn/spend per child)
- [ ] קונפיג תגמול (טריוויה 5/10/20, משימות, 500 יהלום→כרטיס)
- [ ] לוג טרנזקציות יהלומים

**טריוויה**
- [ ] שאלות (question, option_1/2/3, correct_option, level, video_id, source)
- [ ] ייבוא CSV טריוויה
- [ ] 3 רמות קושי + תגמולים
- [ ] מגבלה יומית per-child (ברירת מחדל 9)
- [ ] משובי תשובה (נכון/שגוי, ייחוס וידאו, הגעה למגבלה)

**משימות**
- [ ] סוגי משימות (title, content, reward_diamonds, success_message, related_video_id, sort_order)
- [ ] מעקב השלמה per-child (completed_items)
- [ ] איפוס יומי (daily_reset_hour)

**הגרלות**
- [ ] סוגי הגרלה (diamonds/referrals), סטטוס, draw_date, winner
- [ ] מנגנון: משיכת זוכה, הקצאת קופון, הודעת וואטסאפ
- [ ] תזמון שבועי

**קופונים**
- [ ] בנק קופונים (code, description, status)
- [ ] מימוש (קישור לזוכה הגרלה, חד-פעמי)

**לוח תוצאות**
- [ ] דירוג ילדים לפי יהלומים

**הפניות/שיתוף**
- [ ] קישורי הפניה per-user עם tracking
- [ ] תגמול הפניה (+כרטיס למפנה)

## 4. ניהול תוכן — [B]
- [ ] עורך תפריט CRUD (test env)
- [ ] סוגי node (menu/text)
- [ ] בונה כפתורים (עד 3: id/label/value)
- [ ] הפעלה/כיבוי node
- [ ] ביטול cache תפריט בעדכון/publish
- [ ] עורך הודעות מערכת (welcome/no_results/post_interaction/fallbacks)
- [ ] placeholders בהודעות ({name},{diamonds},{reward},{time},{limit},{date}...)
- [ ] קטגוריות הודעות
- [ ] תמונות בהודעות (image_url/image_mode)
- [ ] בסיס ידע/FAQ CRUD (question/answer/keywords/sort)
- [ ] חיפוש FAQ (+fallback Gemini)
- [ ] קידום שאלה ל-FAQ
- [ ] חגים CRUD (holiday_name, hebrew_date, start/end, emoji, active)
- [ ] תוכן חג בתפריט + חגים קרובים
- [ ] הודעות אוטומטיות CRUD (inactivity_minutes, send_after_minutes, body, buttons, image)

## 5. קמפיינים / Broadcast וואטסאפ — [R]
- [ ] יצירת קמפיין (name, type utility/marketing, message_type, scheduled, rate_limit, template, env)
- [ ] flow: draft→approved→ready→sending→done/paused/failed
- [ ] חיבור הודעה (body + תמונה + עד 3 כפתורים)
- [ ] תמיכת תבניות Meta (שפה he/en/yi + פרמטרים)
- [ ] preview/שליחה-עצמית לבדיקה
- [ ] בניית רשימת נמענים (אנשי קשר [C] / wa_users / CSV)
- [ ] סינון לפי מדינה (prefix)
- [ ] סינון לפי קבוצה [C] / תגית [C]
- [ ] סינון active-last-24h
- [ ] preview נמענים + הסרה ידנית
- [ ] תקרת נמענים + resume ידני
- [ ] שליחה מתוזמנת (timezone-aware)
- [ ] rate limiting (5-60/דק')
- [ ] שליחה מיידית (send now)
- [ ] pause/resume מאמצע
- [ ] לוג נמענים per-campaign (status, sent_at, read_at, wa_message_id, error, from_phone_id)
- [ ] מעקב שגיאות + message ID
- [ ] סטטיסטיקות קמפיין (recipients, sent, read, click, failed, avg time-to-read)

> הערה: ה-broadcast בוואטסאפ ב-smrtReach **שולח דרך תפר התחבורה של smrtBot** (send-service), שאוכף opt-outs/throttle/retries.

## 6. הודעות מתוזמנות (inactivity) — [B]
- [ ] config CRUD (name, active, inactivity_minutes, send_after_minutes, body, buttons, image)
- [ ] טריגר חוסר-פעילות
- [ ] תזמון שליחה (+rate limiting)
- [ ] סטטיסטיקות (סה"כ/היום/השבוע, success/failure)
- [ ] run-now per-user

## 7. אנשי קשר / CRM — [C]
- [ ] CRUD איש קשר (first/last name, phone, email, notes, source, custom fields)
- [ ] פעולות bulk (הוספה לקבוצה/תגית)
- [ ] קבוצות CRUD + שיוך מרובה
- [ ] תגיות CRUD + שיוך
- [ ] חיפוש (שם/טלפון/מייל)
- [ ] סינון לפי קבוצה/תגית/has-email
- [ ] pagination (50/עמוד)
- [ ] ייבוא CSV (modal, preview, מיפוי עמודות, bulk group/tag, תוצאות)
- [ ] sync חד-פעמי מ-wa_users → contacts
- [ ] auto-sync חי מאינטראקציות (זרימה B→C)
- [ ] העדפות מייל (all/weekly/important/none) — **מתואם עם smrtReach**
- [ ] ניהול unsubscribe (email_unsubscribed, email_frequency)
- [ ] ולידציית מייל

## 8. מערכת מייל — [R]
- [ ] קמפיין מייל CRUD (subject, preview_text, provider, sender_name, reply_to, priority, skip_cooldown)
- [ ] עורך HTML עשיר (Quill, RTL)
- [ ] שכפול קמפיין
- [ ] משתני תבנית ({{first_name}} וכו')
- [ ] בונה כפתורים (טקסט/URL/צבעים)
- [ ] עריכת HTML גולמי
- [ ] preview text
- [ ] ספק: **Amazon SES (נבחר)** — Gmail/Postmark מתבטלים
- [ ] שליחה מתוזמנת (date+time)
- [ ] שעות שליחה (חלון, timezone)
- [ ] ימי שליחה (כולל החרגת שבת)
- [ ] rate limiting (1-200/שעה)
- [ ] cooldown בין מיילים לאותו נמען
- [ ] בחירת נמענים (קבוצה/תגית/frequency/has-email) [C]
- [ ] פילטרי deliverability (החרגת unsubscribed/bounced/unvalidated)
- [ ] סגמנטציית priority
- [ ] open tracking (pixel)
- [ ] click tracking (link wrapping)
- [ ] unsubscribe RFC 8058 (one-click)
- [ ] סטטוס delivery (sent/bounced/complaint)
- [ ] אנליטיקס קמפיין (open/click rate, avg time-to-open, by button)
- [ ] עמוד העדפות פומבי (`email-preferences.html`)

## 9. שאלות ומשוב — [B]
- [ ] לוג שאלות לא-תואמות (message_text, phone, name, status)
- [ ] תשובת אדמין (שולח בוואטסאפ)
- [ ] מעקב סטטוס (pending/replied/ignored + reply_at/replied_by)
- [ ] קידום ל-FAQ
- [ ] פאנל משוב (message, status new/read/archived)
- [ ] הערות אדמין על משוב
- [ ] archive/delete

## 10. אנליטיקס / סטטיסטיקות — [B] (מייל ב-[R])
- [ ] משתמשים (סה"כ, active 24h/7d/30d, חדשים היום)
- [ ] הודעות (inbound סה"כ/היום/השבוע)
- [ ] חיפוש (queries, success%, no-match%, nonsense%)
- [ ] מגמת משתמשים חדשים (30 ימים)
- [ ] שעות שיא
- [ ] top failed nodes
- [ ] drill-down: active users (+export)
- [ ] drill-down: user messages (סינון)
- [ ] drill-down: children stats
- [ ] drill-down: search
- [ ] export סטטיסטיקות ל-CSV
- [ ] export לוג נמענים [R]

## 11. לוגים וניהול שגיאות — [B]
- [ ] לוג הודעות מאוחד (bot_logs: direction, message_type, content, matched, error_reason, is_error, env)
- [ ] סינון לוגים (טלפון/כיוון/שגיאה/תאריך/env)
- [ ] export לוגים CSV
- [ ] חיפוש טקסט בתוכן
- [ ] לוג trace וובהוק (level/tag/message/details)
- [ ] סינון trace + סטטיסטיקות (שגיאות 1h/24h, top tags)
- [ ] פאנל שגיאות (אגרגציה לפי tag, count+timestamp)
- [ ] resolve + הערות per-error
- [ ] bulk resolve
- [ ] inspect context מלא
- [ ] retention אוטומטי (>90 ימים) → **pg_cron**

## 12. Publish / Deploy / Versioning — [B]
- [ ] תצוגת draft (test env)
- [ ] תצוגת diff (test↔live) לפני publish
- [ ] publish אטומי (test→live, live ישן→archived:vN)
- [ ] הערת publish
- [ ] היסטוריית גרסאות
- [ ] rollback לגרסה ארכיונית (→live+test)
- [ ] גיבוי אוטומטי לפני restore
- [ ] טבלאות מגורסות (menu/missions/trivia/holidays/knowledge/auto_messages, env+version)
- [ ] snapshot/restore (JSON מלא של מצב הבוט)
- [ ] רשימת גרסאות שפורסמו (date/by/note)

> הערה: publish הוא **פעולת DB** (לא GitHub deploy כמו ב-botsite).

## 13. Audit Trail — [B]
- [ ] audit log מקיף (action, entity, entity_id, user_email, old_value, new_value)
- [ ] סינון audit (entity/action/user/date)
- [ ] תצוגת detail (old/new JSON)
- [ ] סיכום 24h (מה השתנה, לפי משתמש/ישות)

## 14. משתמשים והרשאות — [B]
- [ ] ניהול משתמשים (הוספה/הסרה לפי מייל) → **org_members**
- [ ] super admin → **super_admins של הפלטפורמה**
- [ ] הרשאות per-bot → **`smrtbot_bot_access`** (ב3: גישה per-bot, בלי 6 דגלי פיצ'רים)
- [ ] אכיפה (`requireBotAccess` / `requireRole`)
- [ ] bypass לאדמין (רואה הכל)

> שינוי מודע: 6 דגלי ה-per-feature (can_edit_campaigns/menus/content/game/raffles/deploy) **מתקפלים** ל"גישה מלאה לבוט" לפי החלטת בעל המוצר. אם יידרש בעתיד — נחזיר שכבת per-feature.

## 15. Schedulers / משימות רקע (cron ג3)
- [ ] תזכורות משחק (hourly) [B]
- [ ] תזכורות FOMO (לפני הגרלה) [B]
- [ ] הגרלה יומית 18:00 (משיכה+קופון+וואטסאפ) [B]
- [ ] איפוס משימות יומי (daily_reset_hour, +איפוס מגבלת טריוויה) [B]
- [ ] health check (DB connectivity) [B]
- [ ] שולח הודעות מתוזמנות (inactivity) [B]
- [ ] scheduler broadcast קמפיינים [R]
- [ ] מעבד תור מיילים (send hours + rate) [R]
- [ ] ניקוי retention לוגים (>90 ימים) [B]

> כולם: pg_cron → route חסום ב-Railway (לוגיקת שליחה ב-Node).

## 16. ממשק ניהול — [B]/[C]/[R]
- [ ] ניווט סיידבר (סקשנים: Overview/CRM/Content/Game/Edit/Monitoring/System) → **סקשני אפליקציה בסיידבר סמארטאיזי**
- [ ] שעון timezone בסיידבר + toggle פורמט תאריך (IL/US)
- [ ] בורר בוטים (רק בוטים שלמשתמש יש גישה)
- [ ] טאבי סביבה (test/live)
- [ ] badge ספירת שגיאות (1h)
- [ ] badge שאלות ממתינות
- [ ] badge משוב חדש
- [ ] עורך טקסט עשיר (Quill, RTL) [B]/[R]
- [ ] העלאת תמונה (drag-drop, ולידציה, preview)
- [ ] בורר צבעים (כפתורי מייל) [R]
- [ ] toast notifications
- [ ] טבלאות עם pagination/sort/row-actions
- [ ] bulk select + bulk actions
- [ ] status badges → **טוקני `status-ok/warn/late`**

## 17. נוסף
- [ ] שליחה: sendText/sendButtons/sendList/sendImage/sendVideo/sendDocument [B]
- [ ] תבניות Meta: fetch/send/delete (Graph API) [R]
- [ ] webhook diagnostics (/diagnose: token/WABA/phone/templates) [B]/[R]
- [ ] דירוג וידאו לפי רלוונטיות (top 5) [B]
- [ ] זיהוי בקשת ניווט תפריט [B]
- [ ] זיהוי רעש/ספאם (סינון מהלוג) [B]
- [ ] ולידציית טלפון בינלאומי [B]/[C]/[R]
- [ ] ולידציית CSV טריוויה [B]
- [ ] crash notifier → **`notifyError` + `log_entries`** [B]
- [ ] Google Sheets sync → **מבוטל** (וידאו עובר ל-DB; חגים DB-only)
- [ ] Gmail OAuth → **מבוטל** (SES בלבד)

---

## עקרונות אימות
1. בסוף כל שלב — לעבור על האזורים הרלוונטיים כאן ולסמן `[x]` רק אחרי אימות בפועל.
2. פיצ'ר שמוחלף (OpenAI→Gemini, SES נשאר, GitHub-deploy→DB-publish) — מסומן עם ההחלפה, לא נמחק מהרשימה.
3. פיצ'ר שמקופל מודע (per-feature permissions) — מתועד כהחלטה, לא כאובדן.
4. אם מתגלה פיצ'ר שלא ברשימה — מוסיפים אותו לפני סגירת השלב.
