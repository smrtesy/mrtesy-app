# smrtVoice — תשובות ארכיטקטורה מסמרטאיזי

> **תאריך:** 21.05.2026  
> **מטרה:** מסמך זה מתאר כיצד פלטפורמת smrtesy פועלת כיום, כבסיס לתכנון שירות smrtVoice.  
> **בסיס:** ניתוח מעמיק של ה-codebase, migrations ו-configs.

---

## חלק 1: תקשורת בין שירותים

### 1.1 רשת פנימית בריילוויי

**אין שימוש ב-Railway Private Networking כרגע.**  
כל ה-URLs הם URLs ציבוריים רגילים דרך env vars (`SUPABASE_URL`, `FRONTEND_URL`, `APP_DOMAIN`). אין שום `.railway.internal` בקוד.

**המשמעות עבור smrtVoice:** התקשורת בין smrtesy ל-Voice Engine תהיה דרך URL ציבורי עם API key לאימות, לפחות בשלב הראשון.

---

### 1.2 אימות בקשות יוצאות (סמרטאיזי קוראת לשירות חיצוני)

כל שירות חיצוני מנהל את האימות שלו — אין wrapper אחיד. הדפוסים הקיימים:

| שירות | גישה | מיקום בקוד |
|---|---|---|
| Google Drive / Gmail / Calendar | OAuth2 Bearer token, auto-refresh | `server/src/services/token-refresh.ts:35–89` |
| WhatsApp / Meta API | `Authorization: Bearer <access_token>` מ-Vault | `server/src/modules/smrttask/routes/whatsapp-webhook.ts:1112` |
| Anthropic | API key מ-`app_secrets` או env fallback | `server/src/anthropic.ts` |
| Gemini | API key מ-`app_secrets` | `server/src/gemini.ts:11` |

ה-helper המרכזי לקריאת secrets:

```typescript
// server/src/db.ts:137–178
getAppSecret(appSlug, key, envFallback?)
// סדר עדיפות: app_secrets table → Supabase Vault → env var
// TTL cache: 10 שניות בזיכרון
```

**עבור smrtVoice:** אחסן את ה-API key של Voice Engine ב-`app_secrets` (ממשק האדמין), וקרא אותו דרך `getAppSecret("smrtvoice", "engine_api_key")`.

---

### 1.3 אימות webhooks נכנסים

**קיים דפוס עבור WhatsApp — זהו ה-template לשימוש:**

```typescript
// שלב 1: שמירת raw body לפני JSON parse
// server/src/modules/smrttask/routes/whatsapp-webhook.ts:178–184
express.json({ verify: (req, res, buf) => { req.rawBody = buf } })

// שלב 2: חישוב HMAC
// whatsapp-webhook.ts:234–243
const expectedSig = crypto
  .createHmac("sha256", appSecret)
  .update(rawBody)
  .digest("hex");

// שלב 3: השוואה timing-safe
// whatsapp-webhook.ts:264–269
crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
```

| פרמטר | ערך |
|---|---|
| אלגוריתם | HMAC-SHA256 |
| Header | `x-hub-signature-256` |
| Secret | נקרא מ-Vault דרך `vault_read_secret` |
| Replay protection | אין כרגע (Meta אוכפת בצד שלה) |

**הערה:** אין middleware סטנדרטי `requireWebhookSignature()` — הלוגיקה מוטמעת ישירות. לכשתבנה את smrtVoice, שקול לחלץ זאת ל-middleware משותף.

---

## חלק 2: ניהול קבצים ב-Supabase Storage

### 2.1 Buckets קיימים

| Bucket | Migration | סוג |
|---|---|---|
| `whatsapp-media` | `20260519182922_whatsapp_media_storage.sql:28–30` | private |
| `task-materials` | `20260520044408_task_materials.sql:29–31` | private |

**קונבנציה לשמות:** `<domain>-<type>` (לדוגמה: `smrtvoice-audio`).  
**כל אפליקציה מקבלת bucket משלה** — אין bucket משותף.

---

### 2.2 הרשאות ו-RLS

שני ה-buckets פרטיים. RLS שונה לפי סוג הגישה:

**whatsapp-media — הרשאה ברמת משתמש:**
```sql
-- path convention: <user_id>/<wamid>-<filename>
-- RLS: (storage.foldername(name))[1] = auth.uid()::text
```

**task-materials — הרשאה ברמת org:**
```sql
-- path convention: <org_id>/<task_id>/<uuid>-<filename>
-- RLS: (storage.foldername(name))[1] IN (org_ids של המשתמש הנוכחי)
```

Service role uploads עוקפים RLS אוטומטית.

**עבור smrtVoice:** המבנה המומלץ הוא `<org_id>/<clone_id>/<job_id>/output.mp3` עם RLS ברמת org (כמו task-materials).

---

### 2.3 גישת משתמשים לקבצים

**Signed URLs בלבד** — ה-frontend אף פעם לא מקבל את ה-path הגולמי:

| Bucket | TTL | מיקום |
|---|---|---|
| whatsapp-media | 1 שעה | `server/src/modules/smrttask/routes/whatsapp-view.ts:23` |
| task-materials | שנה (לצורכי UI caching) | `server/src/modules/smrttask/tasks/routes.ts:421` |

דפוס יצירת Signed URL:
```typescript
await db.storage.from(bucket).createSignedUrl(path, ttlSeconds)
```

אין helper מרכזי — כל route מייצר ישירות. **עבור smrtVoice** — TTL של שעה עד 24 שעות הגיוני עבור קבצי אודיו.

---

### 2.4 העלאה מהשרת

השרת משתמש ב-service role key שעוקף RLS:

```typescript
// server/src/db.ts:17 — client נוצר עם SUPABASE_SERVICE_ROLE_KEY
await db.storage
  .from("task-materials")
  .upload(path, buffer, { contentType, upsert: false })
// server/src/modules/smrttask/tasks/routes.ts:412–414
```

**מגבלת גודל נוכחית: 7MB** (דרך Express API — `tasks/routes.ts:404–406`).

> **חשוב לסמרטאיז:** קבצי אודיו של 50–200MB **לא יעבדו דרך ה-API הנוכחי.** Voice Engine חייב להעלות **ישירות לסטורג' Supabase** עם service role key, בלי לעבור דרך ה-Express server של סמרטאיזי.

---

## חלק 3: אבטחה ופרטיות

### 3.1 מידע רגיש

אין מדיניות PII מפורשת בקוד. Supabase מספק encryption at rest אוטומטי (AES-256) — אין צורך בהגדרה נוספת מצד האפליקציה.

---

### 3.2 GDPR / מחיקת נתונים

**אין cron job לניקוי קבצים יתומים.** אין מדיניות retention בקוד. כשמשתמש נמחק — הקבצים בסטורג' **לא נמחקים אוטומטית** (אין cascade מה-DB לסטורג').

**עבור smrtVoice:** שקול לכלול מחיקת קבצים מ-`smrtvoice-audio` bucket כחלק מ-delete flow של clone קולי.

---

### 3.3 לוגים ו-audit

**אין טבלת `log_entries`** (אחרי חיפוש מקיף). מה שיש:

| טבלה | מה היא עוקבת | מיקום Migration |
|---|---|---|
| `run_sessions` | ריצות sync (Part 0/1/2/3), counts, errors_log JSONB | `20260424000001_backend_pipeline.sql:96–138` |
| `action_history` | פעולות AI לכל task, עם cost_usd | `backend_pipeline.sql:143–168` |
| `notifications` | התראות למשתמשים | `20260518000001_platform_integration.sql:6–34` |

אין correlation IDs בין שירותים. `run_sessions.id` משמש כ-operation identifier בתוך ריצה אחת.

---

### 3.4 ניהול secrets

**דפוס שלוש שכבות:**

```
app_secrets table (Supabase)
    └─ is_secret=true  → Supabase Vault (vault_read_secret RPC)
    └─ is_secret=false → value_text ישירות
env vars (Railway)
    └─ fallback אם app_secrets ריק
```

**Cache:** 10 שניות בזיכרון (server/src/db.ts:134–150)

**סבוב מפתחות:** ממשק אדמין קיים — `PUT /admin/apps/:slug/secrets/:key` (`admin/apps/routes.ts:259–330`), כולל Vault RPCs.

**env vars בסיסיים** (מ-`server/.env.example`):
```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
PORT
NODE_ENV
FRONTEND_URL
WHATSAPP_SHEET_ID
```

**עבור smrtVoice — הוסף:**
```
SMRTVOICE_ENGINE_URL
SMRTVOICE_WEBHOOK_SECRET
```

---

## חלק 4: ניהול עבודות רקע

### 4.1 דפוס קיים

**אין BullMQ / Redis / queue כלשהו.** מה שיש:

- `node-cron` לתזמון — `server/src/index.ts:21`
- Cron כל 15 דקות לסנכרון: `"*/15 * * * *"` — `index.ts:193–195`
- עבודות כבדות (Gemini calls) מתבצעות **synchronously** לאחר שליחת תגובת 200 ל-Meta

אין Redis בפרויקט.

---

### 4.2 עבודות ארוכות

**אין דפוס לעבודות ארוכות.** הפתרון הנוכחי: שולחים `200 OK` ל-webhook מקור, ואז מבצעים עבודה. עובד לשניות/דקות — **לא ל-20–40 דקות**.

**עבור smrtVoice — הארכיטקטורה המומלצת:**

```
1. סמרטאיזי → POST /jobs (Voice Engine)
2. Voice Engine → { job_id: "abc123" }  ← מיידי
3. Voice Engine מעבד ברקע (Python celery/rq/asyncio)
4. Voice Engine → POST /api/smrtvoice/webhook (סמרטאיזי) עם HMAC
5. סמרטאיזי → notify() → notifications table
```

---

### 4.3 התראות על סיום

```typescript
// server/src/lib/platform/notify.ts:4–21
await notify({
  orgId,
  userId,
  appSlug: "smrtvoice",
  type: "job_complete",
  title: "הקלון הקולי מוכן",
  body: "עיבוד האודיו הסתיים בהצלחה",
  link: "/smrtvoice/clones/123",
  entityType: "clone",
  entityId: cloneId
})
```

`notify()` **מוכן לשימוש מיידי.** טבלת `notifications` קיימת עם RLS — ה-frontend קורא אותה.

**Real-time:** אין WebSocket/SSE כרגע. אפשר להוסיף Supabase Realtime על טבלת `notifications` בלי שינויים בסכמה.

---

## חלק 5: גישה ומשתמשים

### 5.1 הוספת אפליקציה חדשה ל-org

```sql
-- 20260510000001_platform_foundation.sql:61–67
app_memberships(org_id, app_id, enabled_by, enabled_at)
-- PK: (org_id, app_id)
```

כרגע smrttask נוסף אוטומטית ב-onboarding. **אין endpoint self-service לאפשר app חדש לorg.**

**עבורך:** צור endpoint אדמין:
```
POST /api/admin/apps/smrtvoice/orgs/:orgId/enable
```
שמוסיף שורה ל-`app_memberships`.

---

### 5.2 תפקידים בתוך אפליקציה

**אין תפקידים ברמת אפליקציה.** רק תפקידי org:

```sql
-- 20260510000001_platform_foundation.sql:31–38
org_members(org_id, user_id, role)
-- role: owner | admin | member
```

הגישה כרגע היא all-or-nothing: אם ה-org מוסמך לאפליקציה — כל חברי ה-org גישה מלאה.

---

### 5.3 הרשאות מיוחדות (יצירת קלון קולי)

**אין מנגנון כזה כרגע.** שלוש אפשרויות לפי מורכבות:

| גישה | מימוש | מתי להשתמש |
|---|---|---|
| **פשוט** | `if (user.email !== "chanoch@maor.org") return 403` | MVP / בשלב ראשון |
| **גמיש** | עמודה `app_memberships.can_create_clones boolean DEFAULT false` | כשיש כמה orgs |
| **כללי** | טבלת `app_roles(org_id, app_slug, user_id, permissions jsonb)` | לעתיד |

---

## חלק 6: אינטגרציה עם גוגל

### 6.1 Google APIs

**כן, קיימת אינטגרציה מלאה** ל-Drive, Gmail ו-Calendar.

- **גישה:** OAuth2 עם token של המשתמש (לא Service Account)
- **auto-refresh:** 5 דקות לפני פקיעה — `token-refresh.ts:35–88`
- **revocation handling:** `invalid_grant` → מוחק credential ומנתק — `token-refresh.ts:70–72`

---

### 6.2 אחסון tokens

```sql
-- טבלה: user_credentials
-- עמודות: user_id, service ('google'), access_token,
--          refresh_token, expires_at, scopes
```

**הוספת scopes חדשים:** המשתמש עובר re-OAuth עם scopes מורחבים. אין הוספה ספציפית ל-scope בלי re-auth.

**Drive client example:**
```typescript
// server/src/services/drive.ts:5–8
getDriveClient()  // → OAuth client דרך getOAuthClient()
```

---

## חלק 7: בריאות ומעקב

### 7.1 Health checks

```typescript
// server/src/index.ts:103–105
GET /health → { ok: true, ts: "2026-05-21T..." }
```

**אין בדיקת DB** — רק מאשר שהשרת רץ. Railway יכול להגדיר זאת כ-health check endpoint.

**עבור smrtVoice Engine — מומלץ:**
```json
{ "ok": true, "version": "1.0.0", "db": "connected", "queue_depth": 3 }
```

---

### 7.2 לוגים

- **פורמט:** `console.log/error` — **לא** JSON structured
- **אין correlation IDs** בין שירותים
- **צפייה:** Railway dashboard בלבד
- `run_sessions.id` משמש כ-operation identifier בתוך ריצה אחת

---

### 7.3 ניטור עלויות

| מקום | מה נשמר | מיקום |
|---|---|---|
| `action_history.cost_usd` | עלות לכל פעולת AI | `backend_pipeline.sql:156` |
| `router_decisions.cost_usd` | עלות לכל החלטת router | `router_decisions.sql:50` |
| `user_settings.daily_ai_budget_usd` | תקציב יומי (DEFAULT 10$) | `daily_ai_budget_default_10.sql:6` |

**אין אכיפת budget** — הערך advisory בלבד, ללא rate limiting.

---

## חלק 8: סביבות ופיתוח

### 8.1 סביבות

**סביבה אחת ב-DB.** הבדל dev/prod דרך env vars בלבד:

```typescript
// src/middleware.ts:76–85
if (NEXT_PUBLIC_DEV_BYPASS_AUTH === 'true' && NODE_ENV === 'development')
// → עקיפת auth בdev
```

אין לוגיקה ייחודית ל-staging. כל ההתנהגות נשלטת דרך env vars.

---

### 8.2 פיתוח מקומי

| נושא | מצב |
|---|---|
| Supabase | בענן (לא local instance) |
| עבודות רקע | כן, cron jobs רצות locally עם node-cron |
| auth bypass | `NEXT_PUBLIC_DEV_BYPASS_AUTH=true` לפיתוח ללא Google |

---

### 8.3 דיפלוי

- **Git push** ל-branch → Railway מעלה אוטומטית
- **אין CI/CD רשמי** עם tests אוטומטיים
- שני services ב-Railway: Next.js frontend + Express server

---

## חלק 9: שונות

### 9.1 קונבנציות

**שמות מוצרים:**
- `smrt` + English word, camelCase
- נכון: `smrtVoice`, `smrtTask`, `smrtCRM`
- slug ב-DB: lowercase — `smrtvoice`, `smrttask`, `smrtcrm`

**RTL/LTR:**
- `src/app/[locale]/layout.tsx:16` — dir מוגדר לפי locale (`he` → `dir="rtl"`)
- `RTLProvider.tsx` עוטף את האפליקציה
- זיהוי אוטומטי של טקסט עברי/ערבי: `detectMessageDir()` ב-`whatsapp/utils.ts:11–14`

**i18n:**
- `useTranslations()` / `getTranslations()` — כל string גלוי דרך `src/messages/{he,en}.json`
- אין Storybook

---

### 9.2 מה שכבר בנוי ומוכן לשימוש

| מה | API / מיקום |
|---|---|
| התראות למשתמשים | `notify()` — `server/src/lib/platform/notify.ts` |
| קריאת secrets | `getAppSecret()` — `server/src/db.ts:137–178` |
| Auth middleware | `requireAuth / requireOrg / requireApp` |
| ממשק secrets + rotation | `PUT /admin/apps/:slug/secrets/:key` |
| HMAC webhook validation | template מ-`whatsapp-webhook.ts:234–269` |
| App status updates | `PATCH /api/admin/apps/:slug/status` |
| Subdomain routing | `server/src/index.ts:50–52` |
| Notifications table + RLS | migration `20260518000001` |

---

### 9.3 Lessons Learned מ-smrtTask/smrtCRM

1. **Signed URLs בלבד** — אל תחשוף storage paths ל-frontend ישירות
2. **RLS ברמת org** (לא user) לקבצים שייכים לצוות
3. **`{ error }` חובה** בכל insert/update — silent RLS denials הם הפתעה
4. **קרא CHECK constraints** מה-migrations לפני כל insert לטבלה חדשה
5. **אין hardcoded values** — כל folder ID / email חייב לבוא מ-config
6. **Express size limit = 10MB** — Voice Engine חייב להעלות ישירות לסטורג'

---

## נספח: ארכיטקטורת smrtVoice המומלצת

```
┌─────────────────┐         HTTPS + Bearer token         ┌─────────────────────┐
│   smrtesy        │ ──── POST /jobs ──────────────────► │   Voice Engine       │
│   (Next.js +    │ ◄─── { job_id } ─────────────────── │   (Python service)   │
│    Express)     │                                       │                     │
│                 │                                       │  ┌───────────────┐  │
│  getAppSecret() │ ◄── POST /webhook (HMAC-SHA256) ──── │  │ Background job│  │
│  notify()       │                                       │  │ 20-40 minutes │  │
│  notifications  │                                       │  └───────┬───────┘  │
└─────────────────┘                                       └──────────│──────────┘
                                                                     │
                                                          Direct upload (service role key)
                                                                     │
                                                          ┌──────────▼──────────┐
                                                          │  Supabase Storage   │
                                                          │  smrtvoice-audio    │
                                                          │  <org_id>/<clone_id>│
                                                          │  /<job_id>/out.mp3  │
                                                          └─────────────────────┘
```

**secrets נדרשים:**
```
SMRTVOICE_ENGINE_URL      ← URL של Voice Engine
SMRTVOICE_WEBHOOK_SECRET  ← לאימות HMAC של callbacks
SUPABASE_SERVICE_ROLE_KEY ← ב-Voice Engine לעלאת קבצים
```
