# Brief לתכנון: smrtCRM + smrtReach

> מסמך **עצמאי** להעמקת התכנון של שתי האפליקציות, בצ'אט/סשן נפרד.
> חלק מהגירת botsite → smrtesy. מסמך-האב: `docs/smrtbot-migration-plan.md`.
> צ'קליסט אי-אובדן פיצ'רים: `docs/smrtbot-feature-parity.md`.
> תאריך: 2026-06-03.

---

## 0. ההקשר בקצרה

מערכת botsite (Express + vanilla JS + Postgres על Railway, רב-דיירת לפי `bot_id`)
עוברת לפלטפורמת **smrtesy** ומתפרקת ל-3 אפליקציות (מודל E):

- **smrtBot** — מנוע שיחת וואטסאפ (תפריט/משחק/FAQ/וידאו) + **תחבורת וואטסאפ** (טוקנים, מנוע שליחה, תבניות, opt-outs). *נבנה ראשון.*
- **smrtCRM** — אנשי קשר/קהלים, **org-wide**. ← מסמך זה.
- **smrtReach** — דיוור **רב-ערוצי** (וואטסאפ + מייל), **org-wide**. ← מסמך זה.

**סדר בנייה:** smrtBot → smrtCRM → smrtReach. **תכנון** של CRM/Reach יכול להתבצע במקביל לבניית smrtBot, כל עוד מתייחסים לממשקי smrtBot כחוזה קבוע (סעיף 4).

---

## 1. קונבנציות פלטפורמה (חובה — תקפות לשתי האפליקציות)

> תבנית ייחוס לאפליקציה חדשה: **smrtVoice**. מדריך מלא: `<repo>/...new-app-guide`.

- **מסד נתונים:** פרויקט Supabase יחיד `Smrtesy` (Postgres 17), schema `public`,
  **קידומת לכל אפליקציה** (`smrtcrm_*`, `smrtreach_*`), **RLS** עם policy על `org_members`
  (USING + WITH CHECK). כל טבלה: `id uuid PK DEFAULT gen_random_uuid()`,
  `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`,
  `created_at`, טריגר `updated_at`.
- **דיירות לפי ארגון** — לא לפי בוט. הכל מסונן ב-`org_id`. (botsite היה לפי `bot_id`.)
- **Middleware (שרת Express):** כל route → `requireAuth → requireOrg → requireApp("<slug>")`.
  תפקידים: `requireRole("owner","admin")`. סופר-אדמין: `requireSuperAdmin`.
- **SDK פלטפורמה:** `notify`, `notifyError`, `emitEvent`, `linkEntities`
  (`server/src/lib/platform`). כל פעולה משמעותית → `emitEvent`; כל catch → `notifyError`.
- **שיתוף חוצה-אפליקציות:** דרך `entities.reads` ב-manifest + `linkEntities`.
  **אפליקציה לעולם לא מייבאת קוד מאפליקציה אחרת.**
- **Manifest + registry:** `server/src/apps/<slug>/manifest.ts` + רישום ב-
  `server/src/lib/platform/registry.ts`; פרונט: `src/lib/apps/registry.ts` + אייקון + סקשן בסיידבר.
- **Frontend:** Next.js (Vercel). route group `src/app/[locale]/(app)/(<slug>)/`,
  רכיבים `src/components/<slug>/`. **כל קריאת API דרך `api()`** (`@/lib/api/client`) — אסור `fetch()` גולמי.
- **i18n:** namespace per-app ב-`src/messages/{en,he}.json` + nav keys תחת `"nav"`.
  **כל מחרוזת דרך `t()`**; אסור ternary של locale. שמירת URLs verbatim בכל טקסט שנוצר ע"י AI.
- **סודות:** `app_secrets` (`getAppSecret("<slug>", KEY)`), נערך ממסך admin.
- **Storage:** Supabase Storage buckets, RLS per-org.
- **Cron (מודל ג3):** אין node-cron בשרת. **pg_cron מפעיל route חסום ב-Railway**
  (לוגיקה ב-Node, מנות חסומות, ללא timeout של edge).

## 2. מערכת העיצוב (הוחלה 2026-06-02 — חובה לכל UI)

- **פונט:** Heebo (`font-sans`).
- **טוקנים סמנטיים בלבד** (אסור hex קשיח / `bg-blue-*`): רקע שמנת `#FAFAF7`,
  טקסט `#23231F`, כרטיס לבן, **primary סגול `#534AB7`**, secondary/muted בז' `#F1EFE8`,
  accent `#EEEDFE`, border `#E6E4DC`, radius `0.7rem`.
- **סטטוסים:** `status-ok` ירוק · `status-warn` כתום · `status-late` אדום (טקסט מלא על `-bg`). + dark mode.
- לחקות `components/ui` (shadcn), `AppSectionHeader`, `NavItem`, `AppGuideLayout`.

---

## 3. smrtCRM — מה שסוכם

### היקף
אנשי קשר / קבוצות / תגיות, **org-wide** (משרת את כל הארגון, פרויקטים שונים לקהלים שונים),
עם **סגמנטציה לפי קהל/פרויקט**.

### זרימת נתונים מוסכמת
- **קולט מ-smrtBot:** אנשי קשר מאינטראקציות הבוט (`wa_users`) — זרימה חד-כיוונית בוט → CRM,
  כמו ב-botsite היום (auto-sync באינטראקציה). מנגנון מומלץ: smrtBot `emitEvent` →
  smrtCRM קולט (subscribe) ו-upsert.
- **מקורות נוספים:** ייבוא CSV, הזנה ידנית, ועוד.
- **חושף קהלים** ל-smrtReach לקריאה (`entities.reads`).
- **דרישה מפורשת:** לשמר את **כל** אנשי הקשר עם שדה `source` (מקור: manual/csv/**bot**/...),
  כולל סימון מי הגיע מהבוט.

### טבלאות מקור (botsite) → יעד
| botsite | → smrtCRM | נפח בדמפ |
|---|---|---|
| `contacts` (source, custom_fields, email_unsubscribed, email_frequency) | `smrtcrm_contacts` | **9,175** |
| `contact_groups` | `smrtcrm_groups` | 2 |
| `contact_group_members` | `smrtcrm_group_members` | 9,164 |
| `contact_tags` | `smrtcrm_tags` | 3 |
| `contact_tag_assignments` | `smrtcrm_tag_assignments` | 1 |

> ⚠️ `contacts` ו-`knowledge_base` מתנגשים בשם עם טבלאות קיימות בסמארטאיזי — **קידומת חובה**.
> ⚠️ מפתחות botsite הם `integer` — הגירה דורשת מפת `old_int_id → new_uuid`.

### פיצ'רים לשימור (מתוך parity, סעיף 7)
CRUD אנשי קשר (first/last/phone/email/notes/source/custom_fields) · פעולות bulk ·
קבוצות/תגיות CRUD + שיוך מרובה · חיפוש (שם/טלפון/מייל) · סינון לפי קבוצה/תגית/has-email ·
pagination · ייבוא CSV (preview, מיפוי עמודות, bulk group/tag, תוצאות) · sync חד-פעמי
מ-wa_users · auto-sync חי · העדפות מייל (frequency) + unsubscribe + ולידציה.

### שאלות פתוחות לתכנון
1. **מודל "קהל/פרויקט":** איך מסולקים קהלים שונים (groups/tags קיימים? מושג `audience`/`segment` חדש? קשר ל-`projects`?).
2. **הרשאות:** org-level בלבד? מי רואה/עורך אילו אנשי קשר?
3. **דה-דופליקציה** של אנשי קשר (טלפון/מייל) בייבוא/sync.
4. **custom_fields** — סכמה גמישה (jsonb) או מוגדרת?
5. **מנגנון הקליטה מהבוט** — event subscription (`emitEvent` → handler) מול sync ישיר.
6. **העדפות מייל** — שייכות ל-CRM (כפי שהיום) או ל-smrtReach? (תיאום עם סעיף 4 של Reach).

---

## 4. smrtReach — מה שסוכם

### היקף
דיוור **רב-ערוצי** org-wide: קמפיין channel-agnostic — בוחרים **קהל** (מ-smrtCRM) →
בוחרים **ערוץ** (וואטסאפ / מייל / שניהם) → תזמון → tracking.

### תפרים (חוזה קבוע — לא לשנות את smrtBot)
- **ערוץ וואטסאפ:** smrtReach **לא** נוגע בטוקנים/בקוד שליחה. הוא קורא ל-**send-service של
  smrtBot** (route פנימי / שירות): "שלח תבנית X לטלפונים אלה דרך בוט Y". smrtBot אוכף
  opt-outs (`smrtbot_wa_users.wa_opted_out`), throttle (500ms), retries, ומדווח סטטוס.
- **קהל:** smrtReach קורא מ-smrtCRM דרך `entities.reads: ["smrtcrm_contacts", ...]`.
- **ערוץ מייל:** **Amazon SES** (הוכרע). מפתחות → `app_secrets` (slug `smrtreach`).
  Gmail/Postmark **נזרקים**.
- broadcast בוואטסאפ **תמיד בוחר בוט** (= מספר). צימוד מובנה.
- **לא דיוור:** הודעות שמופעלות מתוך השיחה (תזכורת חוסר-פעילות/FOMO/תזכורת משחק) נשארות ב-smrtBot.

### טבלאות מקור (botsite) → יעד
| botsite | → smrtReach | נפח |
|---|---|---|
| `campaigns` (וואטסאפ) + `email_campaigns` | `smrtreach_campaigns` (channel ∈ whatsapp\|email\|both) | 13 / 3 |
| `campaign_logs` | `smrtreach_campaign_logs` | (הוחרג מהדמפ) |
| `campaign_alerts` | `smrtreach_campaign_alerts` | 0 |
| `contact_lists` (CSV; `file_path` על דיסק!) | `smrtreach_contact_lists` | 1 |
| `email_templates` | `smrtreach_templates` | 0 |
| `email_queue` | `smrtreach_queue` | 6,928 (היסטורי — לא מהגרים) |
| `email_tracking` | `smrtreach_tracking` | 149 |
| `email_campaign_targets` | `smrtreach_campaign_targets` | 4 |
| `email_accounts` (Gmail + טוקנים) | **נזרק** (SES) | 3 |

> ⚠️ `contact_lists.file_path` מצביע לקבצי CSV על דיסק (לא בדמפ) — לטפל בהגירה ל-Storage אם נדרש.
> ⚠️ integer → uuid remap.

### פיצ'רים לשימור (מתוך parity, סעיפים 5+8)
**וואטסאפ broadcast:** flow draft→approved→ready→sending→done/paused/failed · תבניות Meta
(שפה + פרמטרים) · preview/שליחה-עצמית · בניית רשימה (CRM/wa_users/CSV) · סינון
מדינה/קבוצה/תגית/active-24h · preview נמענים + הסרה · תקרת נמענים · תזמון (timezone) ·
rate limiting · send now · pause/resume · לוג נמענים (status/sent_at/read_at/wa_message_id/error) ·
סטטיסטיקות (sent/read/click/failed/avg time-to-read).
**מייל:** קמפיין (subject/preview/sender/reply_to/priority) · עורך HTML עשיר (RTL) · שכפול ·
משתני תבנית · בונה כפתורים · שעות/ימי שליחה (כולל החרגת שבת) · rate limit · cooldown בין
מיילים · פילטרי deliverability (unsubscribed/bounced) · סגמנטציית priority · open/click tracking ·
unsubscribe RFC 8058 (one-click) · עמוד העדפות פומבי · אנליטיקס (open/click rate, avg time-to-open).

### Cron שייך ל-smrtReach (מודל ג3)
- scheduler broadcast קמפיינים (pg_cron → route חסום, שולח דרך smrtBot send-service)
- מעבד תור מיילים (send hours + rate, דרך SES)

### שאלות פתוחות לתכנון
1. **מודל קמפיין channel-agnostic** — סכמה אחת ל-whatsapp/email/both, או טבלאות נפרדות שמתאחדות?
2. **send-service של smrtBot** — הגדרת החוזה המדויק (route? תור? פרמטרים? דיווח סטטוס בחזרה).
3. **tracking** — open/click מובנה (כמו היום, pixels) או דרך יכולות SES?
4. **עמוד העדפות + unsubscribe** — בבעלות Reach או CRM? (תיאום עם CRM סעיף 6).
5. **הרשאות** org-wide.
6. **הגירת `contact_lists`** (קבצי CSV על דיסק) — להעלות ל-Storage או להמיר לקבוצות CRM.
7. **סגמנטציה/priority/cooldown** — איך נשמרים מול מודל ה-CRM.

---

## 5. מה לא להחליט כאן (תלוי ב-smrtBot)
- חוזה ה-send-service ייסגר סופית כשנבנה smrtBot (אבל אפשר לתכנן מולו כהנחה).
- מנגנון ה-event שדרכו smrtBot מזרים אנשי קשר ל-CRM.

## 6. קלט מומלץ לסשן התכנון הנפרד
1. מסמך זה.
2. `docs/smrtbot-migration-plan.md` (מסמך-האב, במיוחד סעיפים 5, 6, 6א, 6ב).
3. `docs/smrtbot-feature-parity.md` (סעיפים 5, 7, 8, 16א).
4. גישה לדמפ + לקוד botsite (`src/contacts/`, `src/email/`, `src/routes/campaignRoutes.js`).
