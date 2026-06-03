# תוכנית-אב: העברת botsite לפלטפורמת smrtesy

> מסמך מקור-אמת אחד להגירה. נכתב לאחר סבב תכנון מלא מול בעל המוצר.
> תאריך: 2026-06-03. סטטוס: **תכנון מאושר — טרם החל ביצוע.**

---

## 1. מטרה

להעביר את מערכת **botsite** (ריפו `maor770/botsite`) לתוך פלטפורמת **smrtesy**, כך
שגישה, משתמשים ופתיחת בוטים מתנהלים דרך smrtesy כמו כל אפליקציה — עם זהות אחת,
מסך ניהול אחד, והרשאות אחידות. botsite מתפרק לשלוש אפליקציות בפלטפורמה.

## 2. מצב המקור (botsite) בקצרה

- **טכנולוגיה:** Express + vanilla JS (admin.html ~152KB + 14 מודולים), PostgreSQL גולמי על Railway, node-cron.
- **רב-דיירות לפי `bot_id`** — ~24 טבלאות, כולן עם `bot_id`. בוט = ישות-העל.
- **אימות:** Google OAuth + session ב-Postgres. `admin_users` + `user_bot_permissions` (הרשאות גרנולריות per-bot).
- **וואטסאפ:** Meta Cloud API, **אפליקציית Meta נפרדת לכל בוט** (phone_number_id/access_token/verify_token per-bot, פיצול test/live). webhook ב-`/:slug/webhook`. אין אימות חתימה.
- **תלות זמן-ריצה ב-Google Sheets:** מאגר הווידאו (טאב `Video_Index`) — לא ב-DB.
- **מדיה:** לוגואים/תמונות על דיסק (`logo_path`, `image_url`).
- **8 משימות node-cron:** broadcast קמפיינים, הודעות מתוזמנות, תור מיילים, תזכורות משחק, FOMO, הגרלה יומית, איפוס משימות, health check.
- **מערכת מיילים:** Amazon SES (+ Postmark/Gmail כחלופות), tracking ידני (pixels).
- **CRM:** אנשי קשר, קבוצות, תגיות.

## 3. מצב היעד (smrtesy) בקצרה

- פרויקט Supabase יחיד `Smrtesy` (`exjnlghuzuvqedlltztz`, Postgres 17). כל האפליקציות באותו DB, schema `public`, קידומת `<slug>_`, RLS לפי `org_id`.
- Frontend: Next.js על **Vercel**. Server: Express על **Railway**. Cron: **pg_cron + Supabase edge functions** (ה-scheduler הישן בשרת הוסר במכוון).
- Auth: Supabase Auth. דיירות לפי **ארגון** — `organizations`, `org_members`, `apps`, `app_memberships`, `super_admins`.
- SDK פלטפורמה: `notify`, `notifyError`, `emitEvent`, `linkEntities`. Manifest per-app + registry.
- תבנית ייחוס לאפליקציה חדשה: **smrtVoice**.

---

## 4. החלטות שנעולות

| # | נושא | הכרעה |
|---|---|---|
| 1 | מבנה ארגון | **ארגון אחד** (מאור), הרבה בוטים. בוט = תת-ישות `smrtbot_bots`. כל טבלה נושאת `org_id` + (היכן רלוונטי) `bot_id`. |
| 2 | מסד נתונים | **אותו** פרויקט Supabase, schema `public`, קידומת לכל אפליקציה, RLS. (לא פרויקט נפרד, לא schema נפרד — היו שוברים את האינטגרציה.) |
| 3 | ממשק | **בנייה מלאה מחדש** ב-React/Next.js. ה-vanilla JS והצבעים הישנים נזרקים. |
| 4 | פירוק לאפליקציות | **שלוש אפליקציות (מודל E):** `smrtBot` (מנוע שיחה + תחבורת וואטסאפ), `smrtCRM` (אנשי קשר/קהלים), `smrtReach` (דיוור רב-ערוצי: וואטסאפ + מייל). |
| 5 | הרשאות | **שתי רמות:** מנהל = `owner`/`admin` (כל הבוטים + ניהול/הוספה/משתמשים), משתמש = `member`. **+ הרשאה per-bot** דרך `smrtbot_bot_access`. אין דגלי per-feature. |
| 6 | Cron | **היברידי (ג3):** pg_cron מפעיל routes חסומים ב-Railway; לוגיקת השליחה נשארת ב-Node. אין עבודה ארוכה ב-edge. |
| 7 | Webhook וואטסאפ | per-bot ב-**Vercel**: `/api/webhooks/smrtbot/[slug]`. verify_token per-bot. (Vercel ולא Railway — אתחול dyno מפיל הודעות.) |
| 8 | מייל | **Amazon SES נשאר** (זול ובנוי לדיוור המוני; כבר עובד). מפתחות → `app_secrets` (slug `smrtreach`). |
| 9 | smart-FAQ | **Gemini** (קיים בפלטפורמה) במקום OpenAI. |
| 10 | אינטגרציה | **עמוקה** — אירועים/קישורים/התראות חוצי-אפליקציות דרך ה-SDK. |
| 11 | עיצוב | מערכת העיצוב החדשה של smrtesy (סעיף 9). |
| 12 | Cutover | downtime מתוכנן מותר; הגירה **בוט-בוט**. |

---

## 5. ארכיטקטורת היעד — שלוש אפליקציות (מודל E)

### עיקרון מפתח: הפרדת "שיחה" מ"דיוור"
וואטסאפ משמש לשני דברים שונים:
- **שיחה (inbound):** משתמש כותב → תפריט/משחק/FAQ. ← `smrtBot`.
- **דיוור (outbound broadcast):** שליחת תבנית לרשימה. ← `smrtReach` (כמו מייל, ערוץ אחר).

### חלוקת אחריות

| אפליקציה | מחזיקה | חושפת/צורכת |
|---|---|---|
| **smrtBot** | מנוע שיחה (תפריט, משחק, FAQ, וידאו, webhook, `wa_users`), **תחבורת וואטסאפ** (טוקנים, מנוע שליחה, תבניות, opt-outs), הודעות-שיחה אוטומטיות | **חושפת** יכולת "שלח וואטסאפ" (שלח תבנית לטלפונים דרך בוט X) |
| **smrtCRM** | אנשי קשר, קבוצות, תגיות, סגמנטציה לפי קהל/פרויקט — **org-wide**. קולט נתונים **מ-smrtBot** (אנשי קשר מאינטראקציות הבוט, כמו היום) **+ מקורות נוספים** | **חושפת** קהלים; **צורכת** אנשי-קשר/אירועים מ-smrtBot |
| **smrtReach** | קמפיינים רב-ערוציים (בחירת קהל → בחירת ערוץ → תזמון → tracking) — **org-wide** | **צורכת** קהל מ-smrtCRM; **צורכת** "שלח וואטסאפ" מ-smrtBot; שולחת מייל דרך SES |

### תפר התחבורה (קריטי — "לא ליפול בין הכיסאות")
- `smrtBot` הוא הבעלים היחיד של תשתית וואטסאפ. **אף אפליקציה אחרת לא נוגעת ב-`smrtbot_bots`/בטוקנים/בקוד השליחה ישירות.**
- `smrtReach` מבקש שליחת broadcast בוואטסאפ דרך **יכולת מוגדרת** של smrtBot (route פנימי / שירות פלטפורמה), שמקבל: bot_id, תבנית, רשימת טלפונים. smrtBot אוכף opt-outs, throttle, retries, ומדווח סטטוס.
- `smrtReach` קורא קהלים מ-smrtCRM דרך `entities.reads` ב-manifest (לא ייבוא קוד).
- `smrtCRM` **קולט** אנשי קשר מ-smrtBot (אינטראקציות / `wa_users`) דרך אירוע/sync — **בנוסף** ל-CSV, הזנה ידנית, ומקורות נוספים. זרימה חד-כיוונית: בוט → CRM (כמו ב-botsite היום).
- broadcast בוואטסאפ **תמיד** בוחר בוט (= מספר). הצימוד הזה מובנה וטבעי.

### הבחנה: מה דיוור ומה לא
- הודעות שמופעלות מ**תוך השיחה** (תזכורת חוסר-פעילות, FOMO, תזכורת משחק) → **smrtBot**.
- broadcast לרשימה → **smrtReach**.

---

## 6. מסד הנתונים — מיפוי טבלאות

כל הטבלאות: `org_id uuid NOT NULL REFERENCES organizations(id)`, RLS עם policy על `org_members`
(USING + WITH CHECK), טריגר `updated_at`. טבלאות ברמת-בוט נושאות גם `bot_id REFERENCES smrtbot_bots(id)`.

### smrtBot
| botsite | → smrtBot | הערות |
|---|---|---|
| `bots` | `smrtbot_bots` | +`org_id`; `test_*`/`live_*` נשמרים; `sheet_url` יבוטל אחרי הגירת וידאו |
| `wa_users` | `smrtbot_wa_users` | כולל `wa_opted_out` (מכובד ע"י broadcast) |
| `menu_nodes` | `smrtbot_menu_nodes` | env/version |
| `bot_messages` | `smrtbot_messages` | תבניות הודעות מערכת |
| `missions_bank`, `trivia` | `smrtbot_missions`, `smrtbot_trivia` | |
| `raffles`, `coupons_bank` | `smrtbot_raffles`, `smrtbot_coupons` | |
| `children`, `diamonds_log` | `smrtbot_children`, `smrtbot_diamonds_log` | מצב משחק |
| `knowledge_base` | `smrtbot_knowledge_base` | ⚠️ התנגשות שם — קידומת חובה |
| `auto_messages` | `smrtbot_auto_messages` | הודעות-שיחה אוטומטיות |
| `holidays` | `smrtbot_holidays` | (DB-only; fallback לגיליון מבוטל) |
| `bot_settings` | `smrtbot_settings` | key/value per-bot |
| `scheduled_message_configs/_logs` | `smrtbot_scheduled_configs/_logs` | הודעות-שיחה מתוזמנות |
| `questions_log`, `feedback` | `smrtbot_questions`, `smrtbot_feedback` | |
| `bot_logs`, `webhook_logs` | `smrtbot_bot_logs`, `smrtbot_webhook_logs` | **+ retention** (pg_cron) |
| `error_logs`, `audit_log` | `smrtbot_error_logs`, `smrtbot_audit_log` | error קריטי → גם `notifyError`+`log_entries` |
| `deploy_snapshots` | `smrtbot_snapshots` | publish test→live (פעולת DB, לא GitHub) |
| **חדש** | `smrtbot_videos` | מהגיליון: `video_name`, `url`, `main_category`, `sub_category`, `sub_category_2`, `rebbe`, `holidays[]`, `vd_id`, `description`, `sort_order`, `active` |
| **חדש** | `smrtbot_bot_access` | `(org_id, bot_id, user_id)` unique `(bot_id,user_id)` — הרשאת per-bot |

> **WhatsApp campaigns:** `campaigns`/`campaign_logs` של botsite הם **broadcast** → עוברים ל-**smrtReach** (סעיף למטה), לא ל-smrtBot.

### smrtCRM
| botsite | → smrtCRM |
|---|---|
| `contacts` | `smrtcrm_contacts` (⚠️ התנגשות שם — קידומת חובה) |
| `contact_groups` | `smrtcrm_groups` |
| `contact_group_members` | `smrtcrm_group_members` |
| `contact_tags` | `smrtcrm_tags` |
| `contact_tag_assignments` | `smrtcrm_tag_assignments` |
| **לתכנון** | מושג "קהל/פרויקט" (segment) — נסגר במעבר-תכנון של smrtCRM |

### smrtReach
| botsite | → smrtReach |
|---|---|
| `campaigns` (וואטסאפ) | `smrtreach_campaigns` (channel-agnostic: `channel ∈ whatsapp\|email\|both`) |
| `campaign_logs` | `smrtreach_campaign_logs` |
| `email_campaigns` | מתמזג ל-`smrtreach_campaigns` (channel=email) |
| `email_opens`, `email_clicks` | `smrtreach_opens`, `smrtreach_clicks` |
| הגדרות מייל/SES | `smrtreach_settings` + מפתחות ב-`app_secrets` |

מיגרציות (לכל אפליקציה): `..._register_<slug>.sql` (INSERT INTO apps + app_status) · `..._<slug>_schema.sql` · `..._smrtbot_storage.sql` · `..._smrtbot_retention.sql`.

---

## 7. שרת — מודולים

- `server/src/modules/smrtbot/` — `index.ts` (router + webhookRouter), `routes.ts` (`requireAuth→requireOrg→requireApp("smrtbot")` + `requireBotAccess`), `wa.ts` (מנוע שליחה: throttle 500ms, retries), `engine/` (webhook handler, menu, game, search — מומר מ-JS ל-TS, queries ל-`smrtbot_*`), `send-service.ts` (היכולת ש-smrtReach קורא), `jobs.ts` (routes חסומים ל-cron).
- `server/src/modules/smrtcrm/` — CRUD אנשי קשר/קבוצות/תגיות.
- `server/src/modules/smrtreach/` — קמפיינים, תזמון, SES, tracking; קורא smrtCRM (קהל) ו-smrtBot send-service (וואטסאפ).
- כל אחד: `apps/<slug>/manifest.ts` + רישום ב-`lib/platform/registry.ts`. Mount ב-`server/src/index.ts` (webhook לפני auth).

**Manifests (אינטגרציה עמוקה):**
- smrtBot `emits`: `bot.created`, `bot.published`, `raffle.drawn`, ... ; `notifications` להתראות אדמין; `errors.default_handler_role: "owner"`.
- smrtCRM `entities.writes`: `smrtcrm_contacts`...
- smrtReach `entities.reads`: `["smrtcrm_contacts"]`; `emits`: `campaign.sent`, `campaign.failed`.

---

## 8. Webhook + Cron

**Webhook (Vercel):** `src/app/api/webhooks/smrtbot/[slug]/route.ts` — GET (handshake מול verify_token של הבוט), POST (זיהוי env לפי phone_number_id → engine). כל אפליקציית Meta מצביעה ל-callback של ה-slug שלה.

**Cron (ג3):** pg_cron מפעיל routes חסומים ב-Railway.
| משימה | תדירות | route | בעלים |
|---|---|---|---|
| broadcast קמפיינים | 60ש' | `/jobs/broadcast` (מנה חסומה) | smrtReach (וואטסאפ דרך smrtBot send-service) |
| תור מיילים | 30ש' | `/jobs/email` | smrtReach |
| הודעות-שיחה מתוזמנות | 60ש' | `/jobs/scheduled` | smrtBot |
| תזכורות משחק / FOMO / הגרלה / איפוס | יומי | routes ייעודיים | smrtBot |
| ניקוי logs (retention) | יומי | SQL בלבד | smrtBot |
| health check | 10 דק' | edge קטן | smrtBot |

---

## 9. עיצוב — מערכת העיצוב של smrtesy (חובה)

הוחלה 2026-06-02 (commits `4f2efb5`, `d0b79d4`). **כל ה-UI שנבנה חייב להשתמש בה.**

- **פונט:** Heebo (`font-sans`).
- **טוקנים (light):** רקע שמנת `#FAFAF7`, טקסט `#23231F`, כרטיס לבן, **primary סגול `#534AB7`** (החליף כחול `#1E4D8C`), secondary/muted בז' `#F1EFE8`, accent `#EEEDFE`, border `#E6E4DC`, radius `0.7rem`.
- **סטטוסים:** `status-ok` ירוק `#1D9E75`, `status-warn` כתום `#EF9F27`, `status-late` אדום `#D85A30` (טקסט מלא על `-bg` חלש). + dark mode מהטוקנים.

**חוקי ברזל:**
1. רק טוקנים סמנטיים (`bg-primary`, `text-foreground`, `border-border`, `rounded-lg`...). **אסור hex קשיח / `bg-blue-*` / הכחול הישן.**
2. כל סטטוסי botsite (קמפיין/הגרלה/משימה...) → `status-ok|warn|late`.
3. dark mode חינם מהטוקנים.
4. לחקות `components/ui` (shadcn), `AppSectionHeader`, `NavItem`, `AppGuideLayout`.

---

## 10. Frontend — מסכים

route groups: `(smrtbot)`, `(smrtcrm)`, `(smrtreach)` תחת `src/app/[locale]/(app)/`. רכיבים תחת `src/components/<slug>/`. אייקונים `Smrt*Icon.tsx`. רישום ב-`src/lib/apps/registry.ts` + סקשנים בסיידבר. i18n: namespace per-app + nav keys, ב-`en.json`+`he.json` (URLs verbatim).

**מסך ניהול בוטים (smrtBot, admin):** פתיחת בוט חדש (`requireRole`) + עריכת פרטים בסיסיים (שם/slug/לוגו/tz/admin_phones) + פרטי וואטסאפ **לייב** ו**טסט**. + guide page לכל אפליקציה.

**Storage:** bucket `smrtbot` (לוגואים/תמונות), RLS per-org.

---

## 11. הרשאות (ב3)

- תפקיד ארגון: מנהל = `owner`/`admin`; משתמש = `member`.
- `requireBotAccess`: מתיר אם `owner`/`admin` (כל הבוטים) **או** שורה ב-`smrtbot_bot_access`. אחרת 403.
- יצירת בוט / ניהול גישה / ניהול משתמשים → `requireRole("owner","admin")`.
- smrtCRM/smrtReach: הרשאות org-level (מודל מדויק נסגר במעבר-התכנון שלהן).

---

## 12. סודות

- וואטסאפ per-bot (phone_number_id/access_token/verify_token) → `smrtbot_bots`.
- SES + Gemini וכו' → `app_secrets` (`getAppSecret("<slug>", KEY)`), נערך ממסך admin.
- **מתבטל לגמרי:** session secret, DATABASE_URL, Google-OAuth login, SUPER_ADMIN_EMAIL, GitHub deploy, UPLOAD_PATH, OpenAI, Postmark, Gmail OAuth, Google Service Account (הספרדשיט מועלה ידנית). אין צורך ב-Meta App Secret (botsite לא מאמת חתימה).

---

## 13. הגירת נתונים + Cutover (בוט-בוט)

מקורות שאינם בריפו (חיים ב-botsite):
1. **`botsite_dump.sql`** — `pg_dump` מלא (ללא טבלאות הלוג הכבדות). דרך Google Cloud Shell (ללא התקנה מקומית). מכיל בוטים+טוקנים, wa_users, כל התוכן.
2. **טאב `Video_Index`** מהספרדשיט כ-CSV (מועלה ידנית → `smrtbot_videos`).
3. **מדיה** (לוגואים/תמונות) → Supabase Storage.

לכל בוט: (1) הגירת דאטה אופליין → (2) עדכון callback ב-Meta + verify → (3) אימות → (4) הבוט הבא. downtime קצר מתוכנן לכל בוט.

---

## 14. סדר ביצוע (לפי ערך)

0. **Scaffolding** — רישום 3 האפליקציות, manifests, registry, אייקונים, i18n namespaces, מודולים ריקים. `npm run build` נקי.
1. **smrtBot ליבה** — סכמה + מנוע (תפריט/משחק/FAQ/וידאו) + webhook + תחבורת וואטסאפ. ← **הבוטים עולים חיים על סמארטאיזי.**
2. **smrtBot cron + Storage + הגירת וידאו**.
3. **smrtBot frontend** (מסך בוטים תחילה) + guide.
4. **הגירת דאטה + cutover בוט-בוט**.
5. **smrtCRM** — מעבר-תכנון ממוקד → סכמה + CRUD + frontend.
6. **smrtReach** — מעבר-תכנון ממוקד → קמפיינים רב-ערוציים (וואטסאפ דרך smrtBot, מייל דרך SES), צריכת קהל מ-smrtCRM.

> smrtCRM ו-smrtReach מקבלים כל אחד **מעבר-תכנון משלו** לפני בנייתם (מודל קהל/סגמנט, הרשאות org-wide, תבניות, tracking).

---

## 15. פתוח / נדרש מבעל המוצר

- [ ] `botsite_dump.sql` (לשלב 4)
- [ ] טאב `Video_Index` כ-CSV (לשלב 2)
- [ ] `org_id` של ארגון "מאור" (או ליצור)
- [ ] אישור downtime קצר לכל בוט ב-cutover
- [ ] מעבר-תכנון smrtCRM (לפני שלב 5)
- [ ] מעבר-תכנון smrtReach (לפני שלב 6)

---

## 16. ערבות אי-אובדן פיצ'רים (Feature Parity)

מטרה מפורשת של בעל המוצר: **שום פיצ'ר קיים לא נאבד בהגירה.** מתוחזק
מסמך-לוויין `docs/smrtbot-feature-parity.md` — צ'קליסט מלא של כל
פיצ'ר ב-botsite (ממשק ניהול, מנוע השיחה, משחק, דיוור, CRM, מיילים,
סטטיסטיקות, לוגים, publish/audit), ממופה לאפליקציית היעד
(smrtBot/smrtCRM/smrtReach) ולסטטוס מימוש. בכל שלב מאמתים מולו לפני סגירה.

## 17. כללי עבודה (מ-CLAUDE.md)

- פרוטוקול pre-push מלא לפני כל push (build נקי, greps, סקירת sub-agent).
- כל insert עם `{ error }` destructuring; כל catch עם `notifyError`; כל פעולה משמעותית עם `emitEvent`.
- i18n דרך `t()` בלבד; API דרך `api()` בלבד; שמירת URLs verbatim בכל טקסט שנוצר ע"י AI.
- אפליקציה לעולם לא מייבאת קוד מאפליקציה אחרת; שיתוף נתונים רק דרך ה-SDK / `entities.reads`.
- מיגרציות: קבצים ממוספרים תחת `supabase/migrations/`; לא להחיל על production ללא אישור מפורש.
