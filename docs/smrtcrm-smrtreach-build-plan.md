# תכנון בנייה מלא: smrtCRM + smrtReach

> מסמך בנייה (build plan) לשתי האפליקציות, מעוגן ב:
> - הכרעות התכנון: `docs/smrtcrm-smrtreach-open-questions.md`
> - ה-Brief המקורי: `c74be4b8-smrtcrmsmrtreachbrief.md`
> - מדריך הפלטפורמה: `docs/new-app-guide.md` (smrtVoice = תבנית הייחוס)
> - קוד המקור botsite (נקרא ב-2026-06-03)
> תאריך: 2026-06-03.

---

## 0. עקרונות מנחים (תקציר)

1. **CRM = מי האדם; Reach = איך וכמה שולחים.** כל תכונה של האדם → CRM; כל החלטת שליחה → Reach.
2. **דיירות לפי `org_id`** (לא `bot_id`). כל טבלה: `id uuid PK`, `org_id` FK + RLS.
3. **אפליקציה לא מייבאת קוד מאפליקציה אחרת.** תקשורת רק דרך `emitEvent`,
   `entities.reads`, `linkEntities`.
4. **תבנית מבנה: smrtVoice** (לא smrtTask — הוא legacy).
5. **שמירת URLs verbatim** בכל טקסט שנוצר ע"י AI. **כל מחרוזת דרך `t()`**.
6. **סדר בנייה כולל:** smrtBot → **smrtCRM** → **smrtReach**. את שתי אלה בונים לפי הסדר;
   חוזה ה-send-service מול smrtBot נסגר כשנבנה smrtBot.

---

## 1. סדר בנייה מומלץ (high-level)

```
שלב A — smrtCRM יסוד        (אנשי קשר + תגיות + קבוצות, CRUD + RLS)         ✅ נבנה
שלב B — smrtCRM ייבוא/קליטה  (CSV import + דה-דופ ✅ ; קליטת אירוע מהבוט — stub, תלוי smrtBot)
שלב C — smrtCRM סגמנטים      (שאילתות סינון שמורות, חשיפה ל-Reach)          ✅ נבנה
שלב D — הגירת נתוני botsite  (סקריפט one-time, מיזוג חוצה-בוטים)            ✅ נבנה
שלב E — smrtReach יסוד       (קמפיין אב + פרטי-ערוץ, קריאת קהלים מ-CRM)     ✅ נבנה
שלב F — smrtReach מייל        (SES, תור, tracking, unsubscribe)             ✅ נבנה (שליחת SES חיה; קורא מפתחות מ-app_secrets)
שלב G — smrtReach וואטסאפ     (חיבור ל-send-service של smrtBot)             ⬜ ממתין ל-smrtBot
שלב H — Cron + scheduler      (pg_cron → route חסום)                        ✅ נבנה (endpoint + מיגרציה; מילוי Vault ע"י המפעיל)
```

CRM (A–D) חייב להסתיים לפני Reach (E–G), כי Reach קורא קהלים מ-CRM.

### מצב מימוש (2026-06-03)
**נבנה ונדחף:** יסוד smrtCRM מלא (CRUD אנשי קשר/תגיות/קבוצות/סגמנטים, חיפוש/סינון/
pagination, bulk, ייבוא CSV, דה-דופ/upsert) + יסוד smrtReach (קמפיינים, פתרון קהל
מ-CRM, תבניות, תצוגת נמענים, עמוד unsubscribe ציבורי שכותב חזרה ל-CRM דרך אירוע).
שתי האפליקציות מחוברות מלא (manifest/registry/sidebar/i18n he+en), build נקי.

**נבנה גם:** מעקב פתיחה/קליקים (פיקסל + עטיפת לינקים ששומרת את ה-deep URL),
webhook ל-bounce/complaint מ-SES (SNS → tracking + unsubscribe), atomic-claim
בתור (בטוח לריצה מקבילה), ו-endpoint cron מאובטח ב-`x-cron-secret` + מיגרציית
pg_cron (תבנית ללא סוד; המפעיל ממלא Vault). **follow-up ידוע:** reaper לשורות
שנתקעות ב-`sending` אחרי קריסה (לאפס ל-`pending` אחרי N דקות) — לא חוסם.

**נותר (תלוי חוץ או היקף):**
- **שליחת מייל SES — נבנתה.** הקוד קורא `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  מ-`app_secrets` (slug `smrtreach`) בזמן ריצה. נותר רק שהמפעיל ימלא את שני הסודות
  במסך ה-admin (region וכתובות שולח מנוהלים מתוך האפליקציה — `smrtreach_settings`
  + `smrtreach_senders`). region לפי שפה: en→us-east-1, he→il-central-1 (ניתן לעריכה).
  לפני חיבור pg_cron: להחליף את בחירת התור ל-atomic claim (מתועד בקוד).
- שליחת וואטסאפ — ממתין לחוזה ה-send-service של **smrtBot**.
- **קליטת אנשי קשר מהבוט** (CRM-5) — subscribe stub, ממתין לשם האירוע מ-smrtBot.
- **Cron scheduler** (שלב H) — טרם (pg_cron → route חסום).

**סקריפט הגירת botsite** (שלב D) נבנה: `server/src/scripts/migrate-botsite.ts`.
קורא JSON exports של טבלאות botsite (פקודות export מתועדות בראש הקובץ), עושה
**מיזוג חוצה-בוטים** ב-union-find (טלפון/מייל משותף → איש קשר אחד עם תגית פרויקט
לכל בוט-מקור), מנרמל טלפון/מייל ומריץ הכנסה ל-Supabase. כולל `--dry-run`, guard
נגד הרצה כפולה (`--force` לעקיפה) ורמז שחזור בכשל. נבדק על fixture.

---

# חלק I — smrtCRM

## 2. סכמת מסד הנתונים (smrtcrm_*)

> מבוסס על מיפוי ה-Brief + דה-דופ של botsite, ממופה ל-org. כל טבלה: RLS עם policy
> על `org_members` (USING + WITH CHECK), טריגר `updated_at`.

### 2.1 `smrtcrm_contacts`
```sql
CREATE TABLE smrtcrm_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES auth.users(id),
  first_name   text,
  last_name    text,
  phone        text,                              -- מנורמל E.164
  email        text,                              -- מנורמל lowercase+trim
  source       text NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual','csv','bot','api','migration')),
  notes        text,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  email_unsubscribed boolean NOT NULL DEFAULT false,   -- CRM-6: האמת על האדם
  email_frequency    text,                              -- CRM-6
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtcrm_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtcrm_contacts_org_members" ON smrtcrm_contacts
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- דה-דופ (CRM-3): ייחודיות לפי org (לא לפי בוט), partial
CREATE UNIQUE INDEX idx_smrtcrm_contacts_org_phone ON smrtcrm_contacts(org_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX idx_smrtcrm_contacts_org_email ON smrtcrm_contacts(org_id, email) WHERE email IS NOT NULL;
```

### 2.2 `smrtcrm_tags` + `smrtcrm_tag_assignments`
```sql
CREATE TABLE smrtcrm_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'manual'
             CHECK (kind IN ('manual','project','source')),   -- CRM-1: תגית פרויקט אוטומטית
  bot_ref    text,                                            -- מזהה בוט-מקור (לתגית project)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE smrtcrm_tag_assignments (
  contact_id uuid NOT NULL REFERENCES smrtcrm_contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES smrtcrm_tags(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
```

### 2.3 `smrtcrm_groups` + `smrtcrm_group_members`
מבנה זהה לתגיות (רשימה ידנית). `groups` = רשימה סטטית; `tags` = שיוך לוגי/פרויקט.

### 2.4 `smrtcrm_segments` (CRM-1 — קהל דינמי)
```sql
CREATE TABLE smrtcrm_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  filter     jsonb NOT NULL DEFAULT '{}',   -- שאילתת סינון שמורה (tags/has-email/source/...)
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```
**סגמנט = שאילתה שמורה**, לא רשימת חברים. נפתר בזמן ריצה. זה מה ש-Reach קורא כ"קהל".

### 2.5 `smrtcrm_field_defs` (CRM-4 — היברידי)
```sql
CREATE TABLE smrtcrm_field_defs (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key       text NOT NULL,                 -- מפתח ב-custom_fields jsonb
  label     text NOT NULL,
  type      text NOT NULL CHECK (type IN ('text','number','date','select','boolean')),
  options   jsonb DEFAULT '[]',            -- ל-select
  UNIQUE (org_id, key)
);
```
הערכים נשמרים ב-`smrtcrm_contacts.custom_fields` (jsonb); הטבלה הזו רק מגדירה מה
מוצג ב-UI ומה הסוג.

### 2.6 `smrtcrm_api_connections` (CRM-1 — חיבור API נושא תגית)
```sql
CREATE TABLE smrtcrm_api_connections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  tag_id     uuid REFERENCES smrtcrm_tags(id),   -- כל איש קשר שנכנס דרך החיבור מקבל תגית זו
  created_at timestamptz NOT NULL DEFAULT now()
);
```

> **תפקידים (הרשאות):** מבנה התפקידים (`project_manager`/`user`) חי בטבלת
> `app_memberships` ברמת הפלטפורמה, לא בסכמת ה-CRM. כרגע שווים — אין אכיפה. ראה §6.

---

## 3. נרמול ודה-דופליקציה (CRM-3)

**פונקציית `upsertContact` (פורט מ-botsite, ממופה ל-org):**
```
normalize: email → lowercase+trim ; phone → E.164
1. אם phone → SELECT id WHERE org_id=? AND phone=?
2. אם !existing AND email → SELECT id WHERE org_id=? AND email=?
3. אם existing → UPDATE ... = COALESCE(new, old)  (מילוי חסר, לא דריסה)
4. אחרת → INSERT
5. תמיד: לוודא תגית מקור/פרויקט משויכת (CRM-1)
```
- כל הכניסות (CSV, bot-event, API, manual) עוברות דרך הפונקציה הזו.
- **חובה לנרמל לפני ההשוואה** — ראה תרחישי מיזוג במסמך השאלות.

---

## 4. קליטה מהבוט (CRM-5) — אירוע

```
smrtBot  →  emitEvent(org, "smrtbot", "wa_user.upserted", "wa_user", id, payload)
smrtCRM manifest.subscribes:
  [{ event: "wa_user.upserted", source: "smrtbot", handler: "onBotContact" }]
handler onBotContact(payload):
  tag = ensureProjectTag(org, payload.bot_name)   // CRM-1: שם נגזר אוטומטית מהבוט
  upsertContact(org, { phone, first_name, last_name, source:'bot' }, tagId: tag.id)
```
- payload נושא `bot_id`/`bot_name` → ממנו נגזרת תגית הפרויקט.
- אסינכרוני; עדיף תור/ניסיון-חוזר כדי שלא יאבדו אנשי קשר.
- **התלות הזו על smrtBot** — שם האירוע המדויק נסגר כשנבנה smrtBot. עד אז: הנחה.

---

## 5. ייבוא CSV (פיצ'רים לשימור)

flow: העלאה → preview → מיפוי עמודות → בחירת תגית (קיימת/חדשה, CRM-1) +
bulk group → הרצה (כל שורה דרך `upsertContact`) → דוח תוצאות (חדש/מוזג/דילוג).
- תצוגת "כפילויות אפשריות" = שיפור UX אופציונלי (ה-upsert כבר מדדפ).

---

## 6. שלבי בנייה — smrtCRM (לפי new-app-guide)

| שלב | פעולה | קובץ/מקום |
|---|---|---|
| 1 | רישום אפליקציה | migration `INSERT INTO apps ('smrtcrm',...)` |
| 2 | סכמה (§2) | migration `..._smrtcrm_schema.sql` |
| 3 | module + routes | `server/src/modules/smrtcrm/{index,routes}.ts` |
| 4 | mount router | `server/src/index.ts` → `app.use("/api", smrtcrmRouter)` |
| 5 | manifest + registry | `server/src/apps/smrtcrm/manifest.ts` + `lib/platform/registry.ts` |
| 6 | route group + page | `src/app/[locale]/(app)/(smrtcrm)/crm/page.tsx` |
| 7 | components | `src/components/smrtcrm/*` |
| 8 | i18n | `src/messages/{en,he}.json` namespace `"smrtCRM"` + nav `"crm"` |
| 9 | registry פרונט + סיידבר | `src/lib/apps/registry.ts` + `Sidebar.tsx` + אייקון |
| 10 | enable for org | `app_memberships` |
| 11 | logging | `log_entries` (category `smrtcrm.contact.*`) |
| 12 | app status | `PATCH /api/admin/apps/smrtcrm/status` |
| 13 | guide page | `(smrtcrm)/crm/guide/page.tsx` |

**manifest טיוטה:**
```typescript
emits: ["contact.created", "contact.merged", "segment.created"],
subscribes: [{ event: "wa_user.upserted", source: "smrtbot", handler: "onBotContact" }],
entities: { reads: [], writes: ["smrtcrm_contacts","smrtcrm_tags","smrtcrm_segments"] },
errors: { default_handler_role: "owner", examples: ["CSV import error","Bot sync error"] },
```

**API routes (יסוד):**
```
GET    /api/crm/contacts            (list + search + filter group/tag/has-email + pagination)
POST   /api/crm/contacts            (create → upsertContact)
PATCH  /api/crm/contacts/:id
DELETE /api/crm/contacts/:id
POST   /api/crm/contacts/bulk       (bulk tag/group/delete)
GET/POST/PATCH/DELETE /api/crm/tags
GET/POST/PATCH/DELETE /api/crm/groups
GET/POST /api/crm/segments
POST   /api/crm/import              (CSV preview + commit)
```
כל route: `requireAuth → requireOrg → requireApp("smrtcrm")`. כל write עם `{ error }`.

---

# חלק II — smrtReach

## 7. סכמת מסד הנתונים (smrtreach_*)

### 7.1 מודל קמפיין (Reach-1) — טבלת-אב + פרטים
```sql
CREATE TABLE smrtreach_campaigns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  name       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('whatsapp','email','both')),
  audience   jsonb NOT NULL DEFAULT '{}',     -- הפנייה לסגמנט/קבוצה/תגית ב-CRM
  status     text NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft','approved','ready','sending','paused','done','failed')),
  scheduled_at timestamptz,
  timezone   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE smrtreach_campaign_email (   -- פרטי ערוץ מייל
  campaign_id uuid PRIMARY KEY REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  subject     text, preview text, sender text, reply_to text,
  priority    text, html_body text, send_hours jsonb, exclude_shabbat boolean DEFAULT true,
  rate_limit  int, cooldown_seconds int          -- Reach-7: priority/cooldown/rate כאן
);

CREATE TABLE smrtreach_campaign_whatsapp ( -- פרטי ערוץ וואטסאפ
  campaign_id uuid PRIMARY KEY REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  bot_ref     text NOT NULL,               -- broadcast תמיד בוחר בוט (=מספר)
  template    text, template_lang text, template_params jsonb, recipient_cap int
);
```

### 7.2 שאר הטבלאות
```
smrtreach_templates        (תבניות מייל; HTML עשיר RTL, משתנים)
smrtreach_campaign_targets (נמענים לקמפיין)
smrtreach_tracking         (open/click מובנה — Reach-3)
smrtreach_queue            (תור שליחה — לא מהגרים היסטוריה)
smrtreach_campaign_logs    (לוג נמענים: status/sent_at/read_at/wa_message_id/error)
```
> **לא מהגרים:** `email_queue` (היסטורי), `email_accounts` (Gmail — מוחלף ב-SES).

---

## 8. ערוץ מייל (Reach-3,4) — SES

- **שליחה:** Amazon SES. מפתחות ב-`app_secrets` (slug `smrtreach`).
- **טראקינג היברידי:**
  - **open/click** → מובנה (פיקסל + לינקים עטופים, `smrtreach_tracking`).
  - **bounce/complaint** → מ-SES (SNS webhook). מעדכן `email_unsubscribed`/bounced.
- **unsubscribe:** RFC 8058 one-click. עמוד העדפות פומבי **מוגש מ-Reach, כותב את
  ההעדפה ל-`smrtcrm_contacts.email_unsubscribed` דרך החוזה החוצה-אפליקציות** (Reach-4/CRM-6).
- **deliverability:** סינון unsubscribed/bounced לפני שליחה (קורא מ-CRM).

---

## 9. ערוץ וואטסאפ (Reach-2) — דרך smrtBot

```
smrtReach scheduler  →  דוחף "מנה" לתור של smrtBot send-service
smrtBot              →  שולח בקצב שלו, אוכף opt-outs + throttle 500ms + retries
                     →  מדווח סטטוס חזרה (אירוע/עדכון רשומה) → smrtreach_campaign_logs
```
- smrtReach **לא** נוגע בטוקנים/קוד שליחה.
- **החוזה המדויק (route? תור? פרמטרים? דיווח) נסגר כשנבנה smrtBot.** עד אז: תכנון מול הנחה.

---

## 10. הרשאות Reach (Reach-5) — שונה מ-CRM

- **גישה לאפליקציה** = app-membership בלבד (רק האחראים על הדיוור מצורפים ל-smrtreach).
  למי שלא צורף — לא מופיעה בסיידבר.
- בתוך המצורפים: **הכל שווה כרגע, כולל כפתור שליחה.** מבנה `project_manager`/`user`
  מוכן להגבלה עתידית (שינוי שורה אחת ב-route, בלי מיגרציה).

---

## 11. Cron (מודל ג3)
- **אין node-cron.** pg_cron מפעיל route חסום ב-Railway.
- שני jobs ל-Reach:
  1. **scheduler broadcast** — שולח קמפיינים מתוזמנים דרך smrtBot send-service.
  2. **מעבד תור מיילים** — לפי send-hours + rate, דרך SES.

---

## 12. שלבי בנייה — smrtReach
זהה במבנה ל-§6 (1–13 של new-app-guide), עם:
```
manifest:
  emits: ["campaign.sent","campaign.done","campaign.failed"],
  subscribes: [{ event:"wa.delivery", source:"smrtbot", handler:"onDelivery" }],
  entities: { reads: ["smrtcrm_contacts","smrtcrm_segments","smrtcrm_groups"], writes:["smrtreach_*"] },
```
- `requireApp("smrtreach")` על כל route.
- קריאת קהלים מ-CRM **רק** דרך `entities.reads` (לא ייבוא קוד).

---

# חלק III — הגירת נתונים (botsite → smrtesy)

## 13. עקרונות הגירה
- **integer → uuid:** מפת `old_int_id → new_uuid` לכל טבלה.
- **bot_id → org_id:** הכל מתכווץ לארגון אחד (או מיפוי בוט→ארגון אם רב-ארגוני).
- **מיזוג חוצה-בוטים (קריטי):** אותו טלפון/מייל בכמה בוטים → איש קשר אחד + כמה תגיות פרויקט.
- **נרמול לפני מיזוג:** מייל lowercase+trim, טלפון E.164.

## 14. סדר הגירה ומיפוי
| botsite | → smrtesy | הערות |
|---|---|---|
| `contacts` (9,175) | `smrtcrm_contacts` | מיזוג חוצה-בוטים; `source` נשמר; תגית פרויקט לכל בוט-מקור |
| `contact_tags` (3) | `smrtcrm_tags` | + יצירת תגיות project מהבוטים |
| `contact_tag_assignments` (1) | `smrtcrm_tag_assignments` | remap ids |
| `contact_groups` (2) | `smrtcrm_groups` | |
| `contact_group_members` (9,164) | `smrtcrm_group_members` | remap ids |
| `campaigns` + `email_campaigns` (13/3) | `smrtreach_campaigns` (+פרטים) | channel לפי מקור |
| `email_templates` (0) | `smrtreach_templates` | ריק |
| `email_tracking` (149) | `smrtreach_tracking` | |
| `email_campaign_targets` (4) | `smrtreach_campaign_targets` | |
| `contact_lists` (1) | — | **מדלגים** (האנשים כבר ב-contacts; Reach-6) |
| `email_queue` (6,928) | — | **לא מהגרים** (היסטורי) |
| `email_accounts` (3) | — | **נזרק** (SES במקום Gmail) |

## 15. סקריפט הגירה — מבנה
```
1. טען דמפ contacts, נרמל phone/email
2. קבץ לפי (org_id, נורמל) — זהה את כפילויות חוצות-בוטים
3. לכל קבוצה: צור איש קשר אחד (COALESCE שדות), שייך תגית project לכל בוט-מקור
4. בנה מפת old_int_id → new_uuid
5. הגר tags/groups/assignments עם remap
6. הגר campaigns/templates/tracking/targets עם remap
7. דלג על contact_lists / email_queue / email_accounts
8. אמת ספירות: כמה מוזגו, כמה חדשים, כמה תגיות נוצרו
```

---

# חלק IV — checklist איכות (לכל push)

לפי CLAUDE.md pre-push protocol:
- [ ] `npm install && npm run build` — אפס שגיאות חדשות
- [ ] grep: כל `db.from(...).insert/update/upsert` עם `{ error }`
- [ ] grep: אין מזהי org/email/folder קשיחים
- [ ] grep: `CHECK` constraints לא מופרים (source, status, role...)
- [ ] כל מחרוזת דרך `t()`, מפתחות ב-{he,en}.json
- [ ] כל קריאת API דרך `api()`, אפס `fetch()` גולמי
- [ ] URLs נשמרים verbatim בכל טקסט AI
- [ ] sub-agent review (Step 3) — אפס findings HIGH/MED
- [ ] עדכון `app_status` אם שונה שלב

---

# נספח — שאלות שעדיין תלויות ב-smrtBot
1. **שם/מבנה האירוע** שדרכו smrtBot מזרים אנשי קשר ל-CRM (§4).
2. **חוזה ה-send-service** המדויק: route/תור, פרמטרים, דיווח סטטוס (§9).

שתי אלה מתוכננות מול הנחה ונסגרות סופית בבניית smrtBot. שאר ההכרעות סגורות
(ראה `docs/smrtcrm-smrtreach-open-questions.md`).
