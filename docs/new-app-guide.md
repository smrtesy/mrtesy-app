# Building a New App Under smrtesy — Step-by-Step Checklist

This document is written for Claude Code. Follow each step in order. Verify at the end of each section before moving on.

App used as example throughout: **smrtCRM** (`slug: smrtcrm`)

---

## Architecture at a Glance

```
smrtesy (platform)          ← manages users, orgs, invites, permissions
  └── apps registered in DB
        smrtTask  (smrttask)   ← existing
        smrtCRM   (smrtcrm)    ← new app example
        smrtHR    (smrthr)     ← etc.
```

Each org enables apps independently. Users get access only if their org has the app enabled.

**Naming rules (from CLAUDE.md):**
- DB slug: always lowercase, no spaces → `smrtcrm`, `smrthr`, `smrtmail`
- Display name: `smrt` + capitalized English word → `smrtCRM`, `smrtHR`, `smrtMail`

---

## STEP 1 — DB: Register the App

Create `supabase/migrations/YYYYMMDDHHMMSS_register_smrtcrm.sql`:

```sql
INSERT INTO apps (slug, name, description)
VALUES (
  'smrtcrm',
  'smrtCRM',
  'Customer relationship management for smrtesy organizations'
);
```

Tell the user to apply via Supabase CLI (`supabase db push`) or the Supabase MCP tool.
Do **not** apply to production without explicit user authorization.

**Verify:** `SELECT slug, name FROM apps WHERE slug = 'smrtcrm';` returns 1 row.

---

## STEP 2 — DB: Create App Tables

Create `supabase/migrations/YYYYMMDDHHMMSS_smrtcrm_schema.sql`.

Rules:
- Table name prefix: `<slug>_` → `smrtcrm_contacts`, `smrtcrm_deals`
- Every table must have `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
- Every table must have `ENABLE ROW LEVEL SECURITY` + an org-members policy

Template:

```sql
CREATE TABLE smrtcrm_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  name       text NOT NULL,
  email      text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE smrtcrm_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members access" ON smrtcrm_contacts
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );
```

**Verify:** List tables and confirm RLS is on. Confirm no `CHECK` constraints are being violated by planned inserts (read the migration file).

---

## STEP 3 — Server: Create the App Module

The module lives at `server/src/modules/smrtcrm/`. Model it exactly after `server/src/modules/smrttask/`.

### 3a — Create the routes file

`server/src/modules/smrtcrm/routes.ts`:

```typescript
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { db } from "../../db";
import { notifyError, emitEvent } from "../../lib/platform";
import { toast } from "sonner"; // server-side: use notifyError, not toast

const router = Router();

// Every route: requireAuth → requireOrg → requireApp("smrtcrm") → handler
router.get("/crm/contacts", requireAuth, requireOrg, requireApp("smrtcrm"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtcrm_contacts")
    .select("*")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ contacts: data ?? [] });
});

router.post("/crm/contacts", requireAuth, requireOrg, requireApp("smrtcrm"), async (req: Request, res: Response) => {
  const { name, email } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  const { data, error } = await db
    .from("smrtcrm_contacts")
    .insert({ org_id: req.org!.id, created_by: req.user!.id, name: name.trim(), email: email?.trim() || null })
    .select("*")
    .single();

  if (error) {
    // Always notifyError in catch blocks
    await notifyError(req.org!.id, "smrtcrm", {
      title: "Failed to create contact",
      body: error.message,
    });
    return res.status(500).json({ error: error.message });
  }

  // Emit event after significant actions
  await emitEvent(req.org!.id, "smrtcrm", "contact.created", "contact", data.id, { name: data.name });

  res.status(201).json({ contact: data });
});

export default router;
```

**Middleware chain reference:**

| Middleware | What it does |
|---|---|
| `requireAuth` | Validates JWT → injects `req.user` |
| `requireOrg` | Validates `X-Org-Id` → injects `req.org` + `req.member` |
| `requireRole("owner","admin")` | Blocks members below the given role |
| `requireApp("slug")` | Checks `app_memberships` → 403 if not enabled for this org |
| `requireSuperAdmin` | Only for `/admin/*` routes — checks `super_admins` table |

### 3b — Create the module index

`server/src/modules/smrtcrm/index.ts`:

```typescript
import { Router } from "express";
import crmRouter from "./routes";

const router = Router();
router.use(crmRouter);

export default router;
```

If the app has background jobs (like smrtTask's cron parts), export them here too:
```typescript
export { runSync } from "./parts/sync";
```

**Verify:** No TypeScript errors. Import paths use `../../db`, `../../middleware`, `../../lib/platform` (two levels up from `modules/smrtcrm/`).

---

## STEP 4 — Server: Mount the Router

Edit `server/src/index.ts`:

```typescript
import smrtcrmRouter from "./modules/smrtcrm";

// ... after existing router mounts:
app.use("/api", smrtcrmRouter);
```

**Verify:** `npm run build` in `server/` passes (or `tsc --noEmit` after `npm install`).

---

## STEP 5 — Server: Write the App Manifest

Create `server/src/apps/smrtcrm/manifest.ts`:

```typescript
import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtcrm",
  name: "smrtCRM",
  // Events this app publishes (other apps may subscribe)
  emits: ["contact.created", "deal.closed"],
  // Events from other apps this app reacts to
  subscribes: [],
  // Which events trigger user notifications (subset of emits)
  notifications: {
    "deal.closed": {
      type:  "success",
      title: "Deal closed",
      body:  "A deal was marked closed in smrtCRM",
    },
  },
  entities: {
    reads:  [],
    writes: ["smrtcrm_contacts"],
  },
  errors: {
    default_handler_role: "owner",
    examples: ["API sync failed", "Contact import error"],
  },
};
```

Register it in `server/src/lib/platform/registry.ts`:

```typescript
import { manifest as smrtcrmManifest } from "../../apps/smrtcrm/manifest";

export const APP_REGISTRY: AppManifest[] = [
  smrttaskManifest,
  smrtcrmManifest,  // add here
];
```

**Answer these 4 questions before writing the manifest:**
1. What significant domain actions does this app perform? → `emits`
2. Does it need to react to actions in other apps? → `subscribes`
3. Who should receive error notifications? (default: org owner) → `errors.default_handler_role`
4. Does it create entities that reference other apps' entities? → use `linkEntities()` in routes

---

## STEP 6 — Frontend: Pages and Route Group

Create the route group folder:
```
src/app/[locale]/(app)/(smrtcrm)/
```

The parentheses make it a **route group** — it does NOT appear in the URL.

Example page `src/app/[locale]/(app)/(smrtcrm)/crm/page.tsx`:

```typescript
import { getTranslations } from "next-intl/server";
import { ContactsClient } from "@/components/smrtcrm/ContactsClient";

export default async function CrmPage({ params }: { params: Promise<{ locale: string }> }) {
  const t = await getTranslations("smrtCRM");
  return (
    <div>
      <h1>{t("title")}</h1>
      <ContactsClient />
    </div>
  );
}
```

**URL result:** `/{locale}/crm` (no `(smrtcrm)` in the path).

---

## STEP 7 — Frontend: Components

Place all components under `src/components/smrtcrm/`.
Model after existing files in `src/components/smrttask/`.

`src/components/smrtcrm/ContactsClient.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface Contact {
  id: string;
  name: string;
  email: string | null;
}

export function ContactsClient() {
  const t = useTranslations("smrtCRM");
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    api<{ contacts: Contact[] }>("/api/crm/contacts")
      .then(({ contacts }) => setContacts(contacts))
      .catch((e) => toast.error(e.message));
  }, []);

  return (
    <ul>
      {contacts.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  );
}
```

**Rules:**
- Always use `api()` from `@/lib/api/client` — never raw `fetch()` to `/api/*`
- Never import from `smrttask/` components — only from `components/ui/` and `components/platform/`

---

## STEP 8 — Frontend: i18n

Add a namespace to **both** `src/messages/en.json` and `src/messages/he.json` in the same commit.

```json
// en.json — add this block
"smrtCRM": {
  "title": "Contacts",
  "noContacts": "No contacts yet",
  "addContact": "Add Contact",
  "nameLabel": "Name",
  "emailLabel": "Email"
}
```

```json
// he.json — add matching block
"smrtCRM": {
  "title": "אנשי קשר",
  "noContacts": "אין אנשי קשר עדיין",
  "addContact": "הוסף איש קשר",
  "nameLabel": "שם",
  "emailLabel": "אימייל"
}
```

**Never** write `locale === "he" ? "..." : "..."` ternaries. Every visible string through `t()`.

---

## STEP 9 — Frontend: Sidebar Navigation

Edit `src/components/platform/layout/Sidebar.tsx`.

Find the nav items array and add your app's entry. It will only render if the org has the app enabled (the sidebar already filters by `enabledApps`):

```typescript
{
  key: "crm",
  label: t("nav.crm"),          // add key to en.json + he.json
  icon: Users,
  href: `/${locale}/crm`,
  appSlug: "smrtcrm",           // gated by this app membership
},
```

Add the i18n keys:
```json
// en.json → nav
"crm": "CRM"

// he.json → nav
"crm": "קשרי לקוחות"
```

---

## STEP 10 — DB: Enable the App for an Org

Via admin UI: **Platform → Organizations → [org] → Apps → toggle on smrtCRM**.

Or via migration (for dev/seed):

```sql
INSERT INTO app_memberships (org_id, app_id, enabled_by)
SELECT '<org_uuid>', id, '<admin_user_uuid>'
FROM apps WHERE slug = 'smrtcrm';
```

---

## STEP 11 — Logging: Write to log_entries

Every error path must write a `log_entries` row so it appears in **Platform → Logs**:

```typescript
import { db } from "../../db";

// In catch blocks (after notifyError):
const { error: logErr } = await db.from("log_entries").insert({
  user_id: req.user!.id,
  level: "error",
  category: "smrtcrm.contact.create",   // app.entity.action
  status: "failed",
  error_message: err.message,
  details: {
    stack: err instanceof Error ? err.stack : undefined,
    org_id: req.org!.id,
    input: req.body,
  },
});
if (logErr) console.error("[log_entries]", logErr.message);

// For successful actions (optional but useful):
await db.from("log_entries").insert({
  user_id: req.user!.id,
  level: "info",
  category: "smrtcrm.contact.create",
  status: "success",
  details: { org_id: req.org!.id, contact_id: data.id },
});
```

---

## STEP 12 — Admin UI: Register App Status

The app appears automatically in **Platform → Admin → Apps** once the DB row exists.

Initialize the status via the API (run once after launch, or at the end of a dev session):

```
PATCH /api/admin/apps/smrtcrm/status
Authorization: Bearer <super-admin token>

{
  "stage": "רעיון",
  "summary": "CRM module scaffolded, basic contact CRUD working.",
  "next_steps": ["Add deal pipeline", "Import from CSV"],
  "blockers": []
}
```

Valid stages in order: `רעיון` → `בניה` → `טסט` → `מאור` → `לקוחות`

Keep the status updated on each significant push (this is Step 4 of the pre-push protocol in CLAUDE.md).

---

## STEP 13 — User Guide Page

Every app must have a guide page at `/{locale}/{main-route}/guide` so users can understand what the app does and how to use it, without needing technical knowledge.

### Create the page

`src/app/[locale]/(app)/(smrtcrm)/crm/guide/page.tsx`:

```typescript
import { Users, BarChart2, Mail } from "lucide-react";
import { AppGuideLayout } from "@/components/platform/AppGuideLayout";
import type { GuideFeature, GuideStep, GuideFAQ } from "@/components/platform/AppGuideLayout";

const features: GuideFeature[] = [
  {
    icon: Users,
    title: "ניהול אנשי קשר",
    description: "כל הלקוחות והגורמים הרלוונטיים במקום אחד, עם היסטוריית תקשורת.",
  },
  {
    icon: BarChart2,
    title: "צינור עסקאות",
    description: "עקוב אחרי עסקאות משלב ראשוני ועד סגירה, עם סטטוס ועדכון בזמן אמת.",
  },
  {
    icon: Mail,
    title: "שילוב ג'ימייל",
    description: "כל מייל שקשור ללקוח מוצמד אוטומטית לכרטיס שלו ב-CRM.",
  },
];

const steps: GuideStep[] = [
  {
    title: "מוסיפים איש קשר",
    description: "מחפשים לקוח קיים או יוצרים חדש עם שם, אימייל וארגון.",
  },
  {
    title: "עוקבים אחרי העסקה",
    description: "פותחים עסקה, מגדירים שלב ועדכון — smrtCRM מעדכן את הצינור בזמן אמת.",
  },
  {
    title: "המערכת מזכירה ומתריעה",
    description: "כשנפתחת עסקה חדשה או כשצריך לפעול, תקבל התראה בתיבה הפנימית.",
  },
];

const faqs: GuideFAQ[] = [
  {
    question: "האם smrtCRM מתחבר לג'ימייל?",
    answer: "כן — כל מייל לכתובת של איש קשר רשום מוצמד אוטומטית לכרטיס שלו.",
  },
];

export default function SmrtCRMGuidePage() {
  return (
    <AppGuideLayout
      appName="smrtCRM"
      tagline="ניהול קשרי לקוחות חכם"
      description="smrtCRM עוזר לך לעקוב אחרי לקוחות, עסקאות ותקשורת — הכל במקום אחד, מחובר לשאר הכלים שלך."
      features={features}
      steps={steps}
      faqs={faqs}
    />
  );
}
```

### Add nav entry in Sidebar

In `src/components/platform/layout/Sidebar.tsx`, add to the app's items array:
```typescript
{ key: "guide", href: "/crm/guide", icon: BookOpen },
```

Add `BookOpen` to lucide imports and `"guide": "מדריך"` / `"guide": "Guide"` to `nav` in both i18n files (if not already there — it's shared across all apps).

### Content guidelines

Write the guide as if explaining to a busy, non-technical manager:
- **Tagline**: one short sentence, what the app does at a glance
- **Description**: 2 sentences max, what problem it solves
- **Features**: 4–8 items, each with a title + 1-sentence description. No jargon.
- **Steps**: 3–6 steps, each describes one concrete thing that happens. Use present tense.
- **FAQ**: 4–8 questions about things users actually ask (privacy, frequency, edge cases)

**Verify:** Navigate to `/{locale}/{route}/guide` in the browser and confirm the page renders with all 4 sections.

---

## STEP 14 — Environment Variables

No new env vars are needed unless the app calls an external API.

If it does, add to Railway (server) and document here:

| Variable | Required | Description |
|---|---|---|
| `SMRTCRM_API_KEY` | if external API | Key for the CRM's external data source |

---

## STEP 14 — Pre-Push Review Protocol

Before `git push`, run the full CLAUDE.md protocol (Steps 1–5). Key items for a new app:

**Step 1 — Build:**
```
npm install --no-audit --no-fund && npm run build
```

**Step 2 — Greps:**
```bash
# Check for missing { error } destructuring on DB writes
grep -n "await db.from.*\.\(insert\|update\|upsert\)(" server/src/modules/smrtcrm/routes.ts

# Check for hardcoded org/user IDs
grep -rn "1wDog\|noreply@maor\|chanoch" server/src/modules/smrtcrm/

# Check CHECK constraints on new tables
grep -n "CHECK" supabase/migrations/*smrtcrm*
```

**Step 3 — Sub-agent review:**
Spawn a `general-purpose` agent with the review prompt from CLAUDE.md Step 3, scoped to changed files.

**Step 4 — Update app status:**
```
PATCH /api/admin/apps/smrtcrm/status
{ stage: "...", summary: "...", next_steps: [...], blockers: [...] }
```

---

## Complete Launch Checklist

Use this before considering the new app "done" for a sprint:

### Database
- [ ] `INSERT INTO apps` migration created and applied
- [ ] App tables created with `smrtcrm_` prefix, `org_id` FK, RLS policy
- [ ] No `CHECK` constraints violated by planned inserts (read migration)

### Server
- [ ] `server/src/modules/smrtcrm/routes.ts` — all routes use `requireAuth + requireOrg + requireApp("smrtcrm")`
- [ ] `server/src/modules/smrtcrm/index.ts` — exports default router
- [ ] `server/src/index.ts` — router mounted under `/api`
- [ ] `server/src/apps/smrtcrm/manifest.ts` — created and registered in `APP_REGISTRY`
- [ ] Every `await db.from(...)` write destructures `{ error }` and handles it
- [ ] Every `catch` block calls `notifyError()`
- [ ] Every significant domain action calls `emitEvent()`
- [ ] Cross-app entity references use `linkEntities()`
- [ ] Error paths write to `log_entries`

### Frontend
- [ ] Route group `src/app/[locale]/(app)/(smrtcrm)/` created
- [ ] Components in `src/components/smrtcrm/`
- [ ] All strings in `src/messages/en.json` + `src/messages/he.json` under `"smrtCRM"` namespace
- [ ] All API calls use `api()` from `@/lib/api/client` — zero raw `fetch()` to `/api/*`
- [ ] Sidebar nav entry added with `appSlug: "smrtcrm"` gate
- [ ] Guide page created at `src/app/[locale]/(app)/(smrtcrm)/crm/guide/page.tsx` using `AppGuideLayout`
- [ ] Guide page linked from sidebar (`{ key: "guide", href: "/crm/guide", icon: BookOpen }`)

### Admin
- [ ] App visible in `/admin/apps` (automatic after DB insert)
- [ ] `app_status` initialized via `PATCH /api/admin/apps/smrtcrm/status`
- [ ] App enabled for at least one org via `app_memberships`

### Quality
- [ ] `npm run build` passes with zero new errors
- [ ] Sub-agent code review run, all HIGH/MED findings fixed
- [ ] No hardcoded IDs, emails, folder IDs, or account names

---

## Folder Structure Reference

After adding smrtCRM, the tree looks like this:

```
server/src/
  index.ts                          ← add: import smrtcrmRouter; app.use("/api", smrtcrmRouter)
  modules/
    platform/                       ← platform core (orgs, members, me, apps, messaging)
    admin/                          ← super-admin routes
    smrttask/                       ← smrtTask module (pattern to follow)
    smrtcrm/                        ← NEW: your app module
      index.ts
      routes.ts
  apps/
    smrttask/manifest.ts            ← existing
    smrtcrm/manifest.ts             ← NEW
  lib/platform/
    registry.ts                     ← add: smrtcrmManifest

src/
  app/[locale]/(app)/
    (platform)/                     ← inbox, settings, admin
    (smrttask)/                     ← tasks, projects, calendar, log
    (smrtcrm)/                      ← NEW: your app pages
      crm/page.tsx
      crm/guide/page.tsx            ← NEW: user guide (AppGuideLayout)
  components/
    ui/                             ← shared primitives
    platform/                       ← layout, org, inbox, onboarding
    smrttask/                       ← smrtTask components
    smrtcrm/                        ← NEW: your app components
      ContactsClient.tsx
  messages/
    en.json                         ← add "smrtCRM" namespace
    he.json                         ← add "smrtCRM" namespace

supabase/migrations/
  ..._register_smrtcrm.sql         ← INSERT INTO apps
  ..._smrtcrm_schema.sql           ← CREATE TABLE smrtcrm_*
```

### Import rules (enforced by convention)
- App code (smrtcrm) imports from: `../../db`, `../../middleware`, `../../lib/platform`, `components/ui/`, `components/platform/`
- App code **never** imports from another app (`smrttask/`, `smrtcrm/` etc.)
- This makes it trivial to extract an app into its own repo: copy `modules/<slug>`, `apps/<slug>`, `app/(<slug>)`, `components/<slug>`

---

## Platform SDK Quick Reference

Full docs: `docs/platform-integration.md`

```typescript
import { notify, notifyError, emitEvent, linkEntities } from "../../lib/platform";

// Notify a specific user
await notify(orgId, userId, {
  type:  "info",                    // "info" | "warning" | "success" | "action_required"
  title: "Import complete",
  body:  "123 contacts imported",
  link:  "/crm",
});

// Notify the org's error handler (owner by default, configurable in Settings)
await notifyError(orgId, "smrtcrm", {
  title: "CRM sync failed",
  body:  err.message,
  link:  "/settings/smrtcrm",
});

// Publish a domain event (triggers notifications defined in the manifest)
await emitEvent(orgId, "smrtcrm", "deal.closed", "deal", dealId, { value: 5000 });

// Cross-app entity link
await linkEntities(orgId, {
  from: { app: "smrtcrm",  entity: "contact", id: contactId },
  to:   { app: "smrttask", entity: "task",    id: taskId    },
  type: "created_from",   // "created_from" | "related_to" | "duplicate_of"
});
```
