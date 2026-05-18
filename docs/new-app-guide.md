# Building a New App Under smrtesy

This guide covers everything needed to add a new app (e.g. `smrtCRM`) to the smrtesy platform.

---

## Architecture Overview

```
smrtesy (platform)
  ├── manages: users, orgs, invites, permissions, super-admins
  └── apps registered in DB:
        smrtTask  (slug: smrtesy)   ← existing
        smrtCRM   (slug: smrtcrm)   ← new app example
        smrtHR    (slug: smrthr)    ← etc.
```

Each **org** enables apps independently. A user gets access to an app only if their org has it enabled.

---

## Step 1 — Register the App in the Database

Run this SQL (create a migration file under `supabase/migrations/YYYYMMDDHHMMSS_register_smrtcrm.sql`):

```sql
INSERT INTO apps (slug, name, description)
VALUES (
  'smrtcrm',
  'smrtCRM',
  'Customer relationship management for smrtesy organizations'
);
```

Naming rules (from CLAUDE.md):
- Slug: always lowercase, no spaces → `smrtcrm`, `smrthr`, `smrtmail`
- Display name: `smrt` + capitalized English word → `smrtCRM`, `smrtHR`, `smrtMail`

---

## Step 2 — Enable the App for an Org

When an org signs up or an admin enables the app:

```sql
INSERT INTO app_memberships (org_id, app_id, enabled_by)
SELECT '<org_uuid>', id, '<admin_user_uuid>'
FROM apps WHERE slug = 'smrtcrm';
```

Or via the admin UI: **Platform → Organizations → [org] → Apps → toggle on**.

---

## Step 3 — Protect Routes in the Express Server

File: `server/src/modules/<your-app>/routes.ts`

```typescript
import { Router } from "express";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";

const router = Router();

// Standard protected route chain:
// requireAuth → requireOrg → requireApp("smrtcrm") → handler
router.get("/crm/contacts", requireAuth, requireOrg, requireApp("smrtcrm"), async (req, res) => {
  // req.user  → { id, email }
  // req.org   → { id, slug, name }
  // req.member → { role: "owner" | "admin" | "member" }
  res.json({ contacts: [] });
});

export default router;
```

### Middleware chain reference

| Middleware | What it does |
|---|---|
| `requireAuth` | Validates JWT, injects `req.user` |
| `requireOrg` | Validates `X-Org-Id`, injects `req.org` + `req.member` |
| `requireRole("owner","admin")` | Blocks members below given roles |
| `requireApp("slug")` | Checks `app_memberships` for this org, returns 403 if not enabled |
| `requireSuperAdmin` | Only for `/admin/*` routes — checks `super_admins` table |

---

## Step 4 — Mount the Router in the Express App

File: `server/src/modules/base/index.ts` (or create `server/src/modules/<app>/index.ts`)

```typescript
import { Router } from "express";
import crmRouter from "./<your-app>/routes";

const router = Router();
router.use(crmRouter);
export default router;
```

Then in `server/src/index.ts`:
```typescript
import crmRouter from "./modules/smrtcrm";
app.use("/api", crmRouter);
```

---

## Step 5 — Frontend API Calls

Use the `api()` client — it automatically attaches `Authorization` and `X-Org-Id`:

```typescript
import { api } from "@/lib/api/client";

// GET
const { contacts } = await api<{ contacts: Contact[] }>("/api/crm/contacts");

// POST
const { contact } = await api<{ contact: Contact }>("/api/crm/contacts", {
  method: "POST",
  body: { name: "Maor", email: "maor@example.com" },
});
```

**Never** use raw `fetch()` to `/api/*` — it bypasses auth headers.

---

## Step 6 — Database Tables for Your App

Create a migration file. All tables must be **org-scoped** with RLS:

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_smrtcrm_schema.sql

CREATE TABLE crm_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;

-- Users can only see contacts in their org
CREATE POLICY "org members access" ON crm_contacts
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );
```

---

## Step 7 — Write Logs (Errors & Activity)

Write to `log_entries` so errors appear in **Platform → Logs** automatically:

```typescript
import { db } from "../db"; // server/src/db.ts

// Minimal error log
await db.from("log_entries").insert({
  user_id: req.user!.id,
  level: "error",           // "info" | "warning" | "error"
  category: "crm.sync",    // dot-separated: app.action
  status: "failed",
  error_message: err.message,
  details: {                // JSONB — put everything useful here
    stack: err.stack,
    org_id: req.org!.id,
    contact_id: contactId,
    input: { name, email },
    http_status: 500,
  },
});

// Activity log
await db.from("log_entries").insert({
  user_id: req.user!.id,
  level: "info",
  category: "crm.contact.created",
  status: "success",
  details: { org_id: req.org!.id, contact_id: newContact.id },
});
```

**`details` is the key field** — put the full context (stack trace, input, IDs, HTTP status) in JSON. This is what shows up in the expandable log view and what you copy to Claude when debugging.

---

## Step 8 — i18n (Translations)

Every user-visible string must go through `useTranslations()`. Never hardcode Hebrew/English.

1. Add a namespace to both `src/messages/en.json` and `src/messages/he.json`:

```json
// en.json
"smrtCRM": {
  "title": "Contacts",
  "noContacts": "No contacts yet",
  "addContact": "Add Contact",
  "nameLabel": "Name",
  "emailLabel": "Email"
}
```

```json
// he.json
"smrtCRM": {
  "title": "אנשי קשר",
  "noContacts": "אין אנשי קשר עדיין",
  "addContact": "הוסף איש קשר",
  "nameLabel": "שם",
  "emailLabel": "אימייל"
}
```

2. Use in a component:

```typescript
"use client";
import { useTranslations } from "next-intl";

export function ContactsPage() {
  const t = useTranslations("smrtCRM");
  return <h1>{t("title")}</h1>;
}
```

3. In a server component / page:

```typescript
import { getTranslations } from "next-intl/server";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const t = await getTranslations("smrtCRM");
  return <h1>{t("title")}</h1>;
}
```

---

## Step 9 — Subdomain Routing

If your app needs a dedicated subdomain (e.g. `crm.smrtesy.com`), add it to the reserved subdomains list in `src/middleware.ts`:

```typescript
const RESERVED_SUBDOMAINS = new Set(["app", "www", "api", "mail", "smtp", "cdn", "crm"]);
```

Otherwise, org subdomains (`maor.smrtesy.com`) already work — the org context is injected automatically via the `smrt_org_id` cookie.

---

## Step 10 — Environment Variables

### Railway (Express server)
| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (bypasses RLS) |
| `ANTHROPIC_API_KEY` | if AI | Claude API key |
| `FRONTEND_URL` | ✅ | Comma-separated allowed CORS origins |
| `APP_DOMAIN` | for subdomains | `smrtesy.com` |
| `VERCEL_TOKEN` | for auto-domains | Vercel API token |
| `VERCEL_PROJECT_ID` | for auto-domains | Vercel project ID |

### Vercel (Next.js frontend)
| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key |
| `NEXT_PUBLIC_BACKEND_URL` | ✅ | Express server URL (e.g. `https://api.smrtesy.com`) |
| `NEXT_PUBLIC_APP_DOMAIN` | ✅ | `smrtesy.com` |
| `SUPABASE_SERVICE_ROLE_KEY` | for admin pages | Shows emails in admin |
| `ADMIN_EMAIL` | ✅ | Comma-separated super-admin emails |
| `RESEND_API_KEY` | for invites | Email sending |

---

## Step 11 — Platform Integration (events, inbox, errors)

Every app must define a manifest so the platform can route events, notifications, and errors
correctly. Full spec: [`docs/platform-integration.md`](./platform-integration.md).

### 11a — Answer these questions before writing code

Before touching the manifest, answer these with the team:

1. **What does this app know about the world?**
   Which entities does it create (customers, orders, conversations...)?
   Which already exist in the platform (`contacts`) and which are new?

2. **What happens in this app that other apps would want to know?**
   These become `emits`. For each: is it actionable (→ smrtTask) or informational (→ info notification)?

3. **What do you need from other apps?**
   These become `subscribes`. For each: which event, from which app, what should you do?

4. **What technical failures can this app produce?**
   List them in `errors.examples` — they guide the error handler configuration.

### 11b — Write the manifest

File: `server/src/apps/<slug>/manifest.ts`

```typescript
import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtbot",
  name: "smrtBot",

  emits: [
    "message.unhandled",
    "lead.detected",
  ],

  subscribes: [
    {
      event:   "task.completed",
      source:  "smrttask",
      handler: "./handlers/on-task-completed",
    },
  ],

  notifications: {
    "message.unhandled": {
      type:  "action_required",
      title: (p) => `פנייה שלא טופלה — ${p.customer}`,
      link:  (p) => `/smrtbot/conversations/${p.conv_id}`,
    },
  },

  entities: {
    reads:  ["contacts"],
    writes: ["contacts"],
  },

  errors: {
    default_handler_role: "owner",
    examples: ["Webhook לא מגיב", "Rate limit חורג"],
  },
};
```

### 11c — Use the platform SDK in your handlers

```typescript
import { emitEvent, notify, notifyError, linkEntities } from "@/lib/platform";

// When something actionable happens
await emitEvent(orgId, "smrtbot", "message.unhandled", "conversation", convId, payload);

// When a technical failure occurs (routes to org error handler automatically)
await notifyError(orgId, "smrtbot", {
  title: "Webhook לא מגיב",
  body:  `POST ${url} → 503`,
  link:  "/settings/smrtbot/connections",
});

// After creating a task in response to a conversation
await linkEntities(orgId, {
  from: { app: "smrtbot",  entity: "conversation", id: convId },
  to:   { app: "smrttask", entity: "task",         id: taskId },
  type: "created_from",
});
```

### 11d — Register the manifest in the event router

File: `server/src/lib/platform/registry.ts`

```typescript
import { manifest as smrtbotManifest } from "../../apps/smrtbot/manifest";

export const APP_REGISTRY = [
  smrtbotManifest,
  // add new manifests here
];
```

---

## Checklist: New App Launch

- [ ] Migration: `INSERT INTO apps (slug, name, description)`
- [ ] Migration: Create org-scoped tables with RLS policies
- [ ] Server: `routes.ts` with `requireAuth + requireOrg + requireApp("slug")`
- [ ] Server: Mount router in `index.ts`
- [ ] Server: Write to `log_entries` with full `details` JSONB on errors
- [ ] Frontend: All strings in `src/messages/{en,he}.json` under a new namespace
- [ ] Frontend: Use `api()` client for all backend calls
- [ ] Admin UI: App will appear automatically in **Platform → Apps** after DB insert
- [ ] Org access: Toggle on via admin UI or seed `app_memberships` in migration
- [ ] **Integration: Answer the 4 questions in Step 11a**
- [ ] **Integration: Write `server/src/apps/<slug>/manifest.ts`**
- [ ] **Integration: Register manifest in `server/src/lib/platform/registry.ts`**
- [ ] **Integration: Write handlers for each subscribed event**
- [ ] **Integration: Use `notifyError()` for all technical failures**

---

## Key Files Reference

```
server/
  src/
    index.ts                        ← Express entry, CORS, cron, router mounts
    db.ts                           ← Supabase service-role client
    middleware/
      index.ts                      ← barrel export
      auth.ts                       ← requireAuth
      org-context.ts                ← requireOrg
      require-app.ts                ← requireApp("slug")
      require-role.ts               ← requireRole(...)
      require-super-admin.ts        ← requireSuperAdmin
    modules/
      base/                         ← user-facing routes (orgs, tasks, projects...)
      admin/                        ← super-admin routes

src/
  middleware.ts                     ← Next.js subdomain routing + org cookie
  lib/api/client.ts                 ← frontend API client (auto-attaches headers)
  messages/en.json                  ← English strings
  messages/he.json                  ← Hebrew strings
  app/[locale]/(app)/admin/         ← Platform admin pages

supabase/migrations/                ← All DDL lives here, named YYYYMMDDHHMMSS_slug.sql
```
