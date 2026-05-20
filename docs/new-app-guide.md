# Building a New App Under smrtesy — Step-by-Step Checklist

This document is written for Claude Code. Follow each step in order. Verify
at the end of each section before moving on.

App used as example throughout: **smrtCRM** (`slug: smrtcrm`)

> **Read first:** `docs/platform-integration.md` for the cross-app
> contract (notifications, events, entity links, error routing) and
> `CLAUDE.md` for naming + pre-push rules.

---

## Architecture at a Glance

```
                    ┌──────────────────────────┐
                    │   smrtesy (platform)      │
                    │                          │
                    │  organizations            │  ← every tenant
                    │  org_members              │  ← who belongs where
                    │  apps + app_memberships   │  ← per-org app gating
                    │  super_admins             │  ← platform-wide role
                    │                          │
                    │  notifications  (inbox)   │  ← cross-app pushes
                    │  app_events     (bus)     │  ← async cross-app routing
                    │  entity_links             │  ← cross-app references
                    │  messages       (1:1/grp) │  ← user-to-user
                    │  contacts (shared)        │  ← platform-owned
                    │  app_status               │  ← dev stage tracking
                    └────────────┬─────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐       ┌───────▼──────┐      ┌───────▼──────┐
   │  smrtTask   │       │   smrtCRM    │      │   smrtHR     │
   │  module     │       │   module     │      │   module     │
   │  manifest   │       │   manifest   │      │   manifest   │
   └─────────────┘       └──────────────┘      └──────────────┘
```

Each org enables apps independently via `app_memberships`. A user gets
access to an app only if **(a)** they are a member of an org and **(b)**
that org has the app enabled.

**Apps never read each other's tables directly.** All cross-app interaction
flows through the platform SDK:

- `notify()` / `notifyError()` — write to `notifications` (the unified inbox)
- `emitEvent()` — publish to `app_events` (async fan-out to subscribers)
- `linkEntities()` — record a cross-app reference in `entity_links`
- `messages` table — direct user-to-user pushes inside an org

**Naming rules (from CLAUDE.md):**
- DB slug: always lowercase, no spaces → `smrtcrm`, `smrthr`, `smrtmail`
- Display name: `smrt` + capitalized English word → `smrtCRM`, `smrtHR`, `smrtMail`
- Never use abbreviations (`smrttsk`), Hebrew (`smrtמשימות`), or hyphens (`smrt-task`).

---

## STEP 1 — DB: Register the App

Create `supabase/migrations/YYYYMMDDHHMMSS_register_smrtcrm.sql`:

```sql
INSERT INTO apps (slug, name, description)
VALUES (
  'smrtcrm',
  'smrtCRM',
  'Customer relationship management for smrtesy organizations'
)
ON CONFLICT (slug) DO NOTHING;

-- Seed initial development status (super-admin dashboard reads this)
INSERT INTO app_status (app_slug, stage, summary)
VALUES ('smrtcrm', 'רעיון', 'אפליקציית CRM — שלד התחלתי')
ON CONFLICT (app_slug) DO NOTHING;
```

Tell the user to apply via Supabase CLI (`supabase db push`) or the Supabase
MCP tool. Do **not** apply to production without explicit user authorization.

**Verify:** `SELECT slug, name FROM apps WHERE slug = 'smrtcrm';` returns 1 row.

---

## STEP 2 — DB: Create App Tables

Create `supabase/migrations/YYYYMMDDHHMMSS_smrtcrm_schema.sql`.

Rules:
- Table name prefix: `<slug>_` → `smrtcrm_contacts`, `smrtcrm_deals`
- Every table must have `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
- Every table must have `ENABLE ROW LEVEL SECURITY` + an org-members policy
- `created_by` text columns (audit columns on platform tables) must use one of
  `('user','claude','system')` — see `CLAUDE.md` skip-rules section.

Template:

```sql
CREATE TABLE smrtcrm_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  name       text NOT NULL,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtcrm_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "smrtcrm_contacts_org_members" ON smrtcrm_contacts
  USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

CREATE INDEX smrtcrm_contacts_org_idx ON smrtcrm_contacts(org_id);
```

**Use shared platform tables** when the entity is cross-cutting:
- People & companies → write to platform `contacts` (set `created_by_app = 'smrtcrm'`)
- Files → upload to Supabase Storage, keep a row referring to it in your app's table
- Inbox items → write through `notify()`, never directly to `notifications`
- Domain events → write through `emitEvent()`, never directly to `app_events`

**Verify:**
- Read your migration and confirm no `CHECK` constraints will be violated by
  planned inserts.
- `SELECT relname FROM pg_class WHERE relrowsecurity = false AND relname LIKE 'smrtcrm_%';`
  must return zero rows.

---

## STEP 3 — Server: Create the App Module

The module lives at `server/src/modules/smrtcrm/`. Model it exactly after
`server/src/modules/smrttask/`.

### 3a — Create the routes file

`server/src/modules/smrtcrm/routes.ts`:

```typescript
import { Router, type Request, type Response } from "express";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { db } from "../../db";
import { notifyError, emitEvent } from "../../lib/platform";

const router = Router();

// Standard chain on every protected route:
//   requireAuth → requireOrg → [requireRole(...)] → requireApp("smrtcrm")
router.get(
  "/crm/contacts",
  requireAuth,
  requireOrg,
  requireApp("smrtcrm"),
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("smrtcrm_contacts")
      .select("*")
      .eq("org_id", req.org!.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ contacts: data ?? [] });
  },
);

router.post(
  "/crm/contacts",
  requireAuth,
  requireOrg,
  requireApp("smrtcrm"),
  async (req: Request, res: Response) => {
    const { name, email } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });

    const { data, error } = await db
      .from("smrtcrm_contacts")
      .insert({
        org_id:     req.org!.id,
        created_by: req.user!.id,
        name:       name.trim(),
        email:      email?.trim() || null,
      })
      .select("*")
      .single();

    if (error) {
      // Route the failure to the org's error handler (defaults to owner).
      await notifyError(req.org!.id, "smrtcrm", {
        title: "Failed to create contact",
        body:  error.message,
      });
      return res.status(500).json({ error: error.message });
    }

    // Publish a domain event. Other apps subscribed via their manifest
    // will be invoked automatically. If the manifest below declares a
    // notification for this event, the inbox is also written.
    await emitEvent(req.org!.id, "smrtcrm", "contact.created", "contact", data.id, {
      name: data.name,
    });

    res.status(201).json({ contact: data });
  },
);

export default router;
```

**Middleware chain reference (`server/src/middleware/index.ts`):**

| Middleware | What it does |
|---|---|
| `requireAuth` | Validates JWT → injects `req.user` |
| `requireOrg` | Validates `X-Org-Id` → injects `req.org` + `req.member` |
| `requireRole("owner","admin")` | Blocks members below the given role |
| `requireApp("slug")` | Checks `app_memberships` → 403 if not enabled for this org |
| `requireSuperAdmin` | Only for `/admin/*` routes — checks `super_admins` table |

> **Never use `toast` server-side.** It's a client library. On the server,
> failures go to `notifyError()` + a `log_entries` row (see STEP 11).

### 3b — Create the module index

`server/src/modules/smrtcrm/index.ts`:

```typescript
/**
 * smrtCRM module — customer relationship app.
 * Self-contained: routes, helpers, jobs.
 * To extract to a separate repo, copy this directory + `server/src/apps/smrtcrm/`.
 */

import { Router } from "express";
import crmRouter from "./routes";

const router = Router();

// If you have a PUBLIC webhook (no auth), mount it FIRST — before any
// authenticated router. Inside a sub-router that itself receives
// `requireAuth` upstream, the only way to keep a path public is to mount
// it at the application root in `server/src/index.ts`. See STEP 4.

router.use(crmRouter);

export default router;

// If the app has background jobs, re-export them here so the cron
// scheduler in server/src/index.ts can pull them in.
//   export { runDailySync } from "./parts/sync";
```

**Verify:** `npm run build` passes. Import paths are exactly
`../../db`, `../../middleware`, `../../lib/platform` (two levels up from
`modules/smrtcrm/`). Anything else is wrong.

---

## STEP 4 — Server: Mount the Router

Edit `server/src/index.ts`. The ordering matters — see the WhatsApp webhook
saga (PRs #33, #34) for what happens when you get it wrong.

```typescript
import smrtcrmRouter from "./modules/smrtcrm";

// ── Mount order ──────────────────────────────────────────────────────────
// 1) PUBLIC webhooks (no auth) at app level, ABOVE the auth-guarded routers.
//    Express runs middleware in registration order; once a router applies
//    requireAuth at its root, every nested path inherits it, so an
//    unauthenticated Meta/Stripe/etc. webhook would 401 even if the
//    handler itself is public.
// app.use("/api", smrtcrmPublicWebhookRouter);   // if your app has one
//
// 2) Platform, admin, app modules (all require auth).
// app.use("/api", platformRouter);
// app.use("/api", adminRouter);
app.use("/api", smrtcrmRouter);
```

**Verify:** `npm install --no-audit --no-fund && npm run build` in repo
root passes. (See CLAUDE.md → Pre-push protocol — `tsc --noEmit` alone is
not enough.)

---

## STEP 5 — Server: Write the App Manifest

Create `server/src/apps/smrtcrm/manifest.ts`:

```typescript
import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtcrm",
  name: "smrtCRM",

  // Events this app publishes via emitEvent(). Other apps may subscribe.
  emits: [
    "contact.created",
    "deal.created",
    "deal.closed",
  ],

  // Events from other apps this app reacts to.
  //   handler is a path under server/src/apps/<this-app>/...
  //   the loader does `import("../../apps/smrtcrm/" + handler)`
  subscribes: [
    // Example:
    // { event: "task.completed", source: "smrttask", handler: "handlers/on-task-completed" },
  ],

  // Map emit-events to inbox cards. If an entry exists, emitEvent()
  // will ALSO write a notification (routed to the org's owner by
  // default; for user-specific targeting, call notify() directly).
  notifications: {
    "deal.closed": {
      type:  "success",
      title: (p) => `עסקה נסגרה — ${p.deal_name ?? "ללא שם"}`,
      body:  (p) => p.value ? `שווי: ${p.value} ₪` : undefined,
      link:  (p) => `/crm/deals/${p.deal_id}`,
    },
  },

  // Shared platform entities this app reads or writes. Used for docs
  // and future cross-app audit; nothing enforces it yet.
  entities: {
    reads:  ["contacts"],
    writes: ["contacts", "smrtcrm_contacts", "smrtcrm_deals"],
  },

  // Where technical errors go via notifyError().
  // "owner" = org owner (default). "admin" routes to the first admin.
  // Per-org override lives in organizations.error_handler_user_id and
  // is configurable in Manage Org → שגיאות טכניות.
  errors: {
    default_handler_role: "owner",
    examples: [
      "Failed to sync contacts from external CRM",
      "Deal pipeline webhook returned 5xx",
    ],
  },
};
```

Register it in `server/src/lib/platform/registry.ts`:

```typescript
import type { AppManifest } from "./types";
import { manifest as smrttaskManifest } from "../../apps/smrttask/manifest";
import { manifest as smrtcrmManifest  } from "../../apps/smrtcrm/manifest";  // ← add

export const APP_REGISTRY: AppManifest[] = [
  smrttaskManifest,
  smrtcrmManifest,  // ← add
];
```

**Answer these 4 questions before writing the manifest:**
1. What significant domain actions does this app perform? → `emits`
2. Does it need to react to actions in other apps? → `subscribes`
3. Should any of the emitted events show up in the unified inbox?
   → add a `notifications` entry
4. Who should receive error notifications? (default: org owner)
   → `errors.default_handler_role`

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
    <div className="p-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <ContactsClient />
    </div>
  );
}
```

**URL result:** `/{locale}/crm` (no `(smrtcrm)` in the path).

The `(app)/layout.tsx` already enforces auth + onboarding + redirects users
without an active org. Your route group inherits that — no extra guards
needed at the page level.

---

## STEP 7 — Frontend: Components

Place all components under `src/components/smrtcrm/`.
Model after existing files in `src/components/smrttask/`.

`src/components/smrtcrm/ContactsClient.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

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

  if (contacts.length === 0) return <p className="text-muted-foreground">{t("noContacts")}</p>;

  return (
    <ul className="space-y-2">
      {contacts.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  );
}
```

**Rules:**
- All API calls go through `api()` from `@/lib/api/client` — never raw
  `fetch("/api/...")`. The helper auto-attaches `Authorization` and
  `X-Org-Id` headers.
- Realtime is the **only** exception where direct Supabase client is
  allowed: `createClient()` from `@/lib/supabase/client` + `.channel()`
  + `postgres_changes`. See `Sidebar.tsx` for the pattern.
- Never import from `smrttask/` components — only from `components/ui/`
  and `components/platform/`.

---

## STEP 8 — Frontend: i18n

Every user-visible string goes through `useTranslations()` /
`getTranslations()`. Add a namespace to **both** `src/messages/en.json`
and `src/messages/he.json` in the same commit. **Never** write
`locale === "he" ? "..." : "..."` ternaries.

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

The build refuses keys present in one locale but not the other — if you
hit a missing-key error at runtime, you forgot to update the second file.

---

## STEP 9 — Frontend: Sidebar Navigation

Edit `src/components/platform/layout/Sidebar.tsx`.

**Gating model:** the sidebar reads `enabledApps` (a `string[]` of slugs
the active org has enabled) and gates **entire sections**, not individual
items. See line 81 where `hasSmrtTask = enabledApps.includes("smrttask")`
toggles the whole smrtTask block.

For a new app, add a `hasSmrtCRM` flag and a section block:

```typescript
// near the top of Sidebar()
const hasSmrtCRM = enabledApps.includes("smrtcrm");

// items lists outside the component:
const smrtCRMItems = [
  { key: "contacts", href: "/crm",       icon: Users    },
  { key: "guide",    href: "/crm/guide", icon: BookOpen },
] as const;

// inside the JSX, after the smrtTask section:
{hasSmrtCRM && (
  <>
    <SectionLabel>smrtCRM</SectionLabel>
    {smrtCRMItems.map((it) => (
      <NavItem key={it.key} itemKey={it.key} href={it.href} icon={it.icon} />
    ))}
  </>
)}
```

Add the i18n keys:
```json
// en.json → "nav": { ..., "contacts": "Contacts" }
// he.json → "nav": { ..., "contacts": "אנשי קשר" }
```

`guide` is already in `nav` (shared across apps). Add `Users` / any
lucide icon you use to the imports at the top of `Sidebar.tsx`.

---

## STEP 10 — DB: Enable the App for an Org

Two ways — pick based on who is operating:

### Via the Super-Admin Console (recommended)

**Platform → Admin → Organizations → [org] → Apps → toggle on smrtCRM**.

This writes `app_memberships` with `enabled_by = <super_admin_user_id>`
and `enabled_at = now()`.

### Via migration (dev/seed only)

```sql
INSERT INTO app_memberships (org_id, app_id, enabled_by)
SELECT '<org_uuid>', id, '<admin_user_uuid>'
FROM apps WHERE slug = 'smrtcrm'
ON CONFLICT (org_id, app_id) DO NOTHING;
```

A user who is a member of that org will now see smrtCRM in their
sidebar after refreshing. The platform's `/api/me/effective-access`
endpoint resolves their final app set; `requireApp("smrtcrm")` reads
the same table on every request.

---

## STEP 11 — Logging: Write to `log_entries`

Every error path must write a `log_entries` row so it appears in
**Platform → Admin → Logs**. This is separate from `notifyError()` —
the inbox notification surfaces a single human-readable item to the
error handler; `log_entries` captures the structured trail for ops.

```typescript
import { db } from "../../db";

// In catch blocks (after notifyError):
const { error: logErr } = await db.from("log_entries").insert({
  user_id:       req.user!.id,
  level:         "error",
  category:      "smrtcrm.contact.create",   // app.entity.action
  status:        "failed",
  error_message: err.message,
  details: {
    stack:  err instanceof Error ? err.stack : undefined,
    org_id: req.org!.id,
    input:  req.body,
  },
});
if (logErr) console.error("[log_entries]", logErr.message);

// For successful actions (optional but useful for audit):
await db.from("log_entries").insert({
  user_id:  req.user!.id,
  level:    "info",
  category: "smrtcrm.contact.create",
  status:   "success",
  details:  { org_id: req.org!.id, contact_id: data.id },
});
```

---

## STEP 12 — Admin UI: Track App Status

The app appears automatically in **Platform → Admin → Apps** once the
`apps` row exists. The `app_status` table tracks dev progress through
five stages.

Update via API at the end of each significant push:

```
PATCH /api/admin/apps/smrtcrm/status
Authorization: Bearer <super-admin token>

{
  "stage":      "בניה",
  "summary":    "CRUD לאנשי קשר עובד; חסרה התראה על עסקה שנסגרת.",
  "next_steps": ["צינור עסקאות", "ייבוא מ-CSV"],
  "blockers":   []
}
```

Valid stages **in order**:
`רעיון` → `בניה` → `טסט` → `מאור` → `לקוחות`

The DB-level `CHECK` enforces this set; any other string is rejected.
Keep the status fresh — this is Step 4 of the pre-push protocol in
`CLAUDE.md`.

---

## STEP 13 — User Guide Page

Every app must have a guide page at `/{locale}/<main-route>/guide` so
users can understand what the app does and how to use it, without
needing technical knowledge.

### Create the page

`src/app/[locale]/(app)/(smrtcrm)/crm/guide/page.tsx`:

```typescript
import { Users, BarChart2, Mail } from "lucide-react";
import { AppGuideLayout } from "@/components/platform/AppGuideLayout";
import type {
  GuideFeature,
  GuideStep,
  GuideFAQ,
} from "@/components/platform/AppGuideLayout";

const features: GuideFeature[] = [
  {
    icon: Users,
    title: "ניהול אנשי קשר",
    description: "כל הלקוחות והגורמים הרלוונטיים במקום אחד, עם היסטוריית תקשורת.",
  },
  {
    icon: BarChart2,
    title: "צינור עסקאות",
    description: "עוקבים אחרי עסקאות משלב ראשוני ועד סגירה, עם סטטוס ועדכון בזמן אמת.",
  },
  {
    icon: Mail,
    title: "שילוב ג'ימייל",
    description: "כל מייל שקשור ללקוח מוצמד אוטומטית לכרטיס שלו.",
  },
];

const steps: GuideStep[] = [
  { title: "מוסיפים איש קשר",     description: "מחפשים לקוח קיים או יוצרים חדש." },
  { title: "עוקבים אחרי העסקה",   description: "פותחים עסקה, מגדירים שלב, smrtCRM מעדכן את הצינור." },
  { title: "המערכת מזכירה",       description: "התראות בתיבה הפנימית על עסקאות וקשרים שדורשים פעולה." },
];

const faqs: GuideFAQ[] = [
  {
    question: "האם smrtCRM מתחבר לג'ימייל?",
    answer:   "כן — כל מייל לכתובת של איש קשר רשום מוצמד אוטומטית לכרטיס שלו.",
  },
];

export default function SmrtCRMGuidePage() {
  return (
    <AppGuideLayout
      appName="smrtCRM"
      tagline="ניהול קשרי לקוחות חכם"
      description="smrtCRM עוזר לעקוב אחרי לקוחות, עסקאות ותקשורת — הכל במקום אחד."
      features={features}
      steps={steps}
      faqs={faqs}
    />
  );
}
```

### Content guidelines

Write as if explaining to a busy, non-technical manager:
- **Tagline**: one short sentence, what the app does at a glance.
- **Description**: 2 sentences max, what problem it solves.
- **Features**: 4–8 items, each with title + 1-sentence description. No jargon.
- **Steps**: 3–6 steps, present tense, one concrete thing per step.
- **FAQ**: 4–8 questions about things users actually ask
  (privacy, frequency, edge cases).

Add the guide link in `Sidebar.tsx` (already shown in STEP 9).
`"guide"` is shared across all apps — already in both i18n files.

**Verify:** Navigate to `/{locale}/<route>/guide` in a browser and confirm
all four sections render.

---

## STEP 14 — Platform SDK: Cross-App Integration

The platform SDK is the **only** sanctioned way an app touches another
app. Full docs: `docs/platform-integration.md`.

```typescript
import {
  notify,
  notifyError,
  emitEvent,
  linkEntities,
  getLinks,
} from "../../lib/platform";

// ── Inbox: notify a specific user ────────────────────────────────────────
await notify(orgId, userId, {
  app_slug:    "smrtcrm",                   // REQUIRED
  type:        "info",                      // "info" | "warning" | "success" | "action_required"
  title:       "ייבוא הושלם",
  body:        "123 אנשי קשר נוספו",
  link:        "/crm",
  entity_type: "contact",                   // optional
  entity_id:   contactId,                   // optional
  // from_user_id: senderUserId             // only for user-to-user pushes
});

// ── Inbox: route a technical error to the org's handler ─────────────────
await notifyError(orgId, "smrtcrm", {
  title: "Sync to external CRM failed",
  body:  err.message,
  link:  "/settings/smrtcrm",
});
// notifyError resolves organizations.error_handler_user_id first,
// then falls back to organizations.created_by (the owner).

// ── Event bus: fan out a domain action ──────────────────────────────────
await emitEvent(orgId, "smrtcrm", "deal.closed", "deal", dealId, {
  deal_name: "אקמה — חוזה שנתי",
  value:     50000,
});
// emit() will:
//   1. INSERT into app_events
//   2. If your manifest's notifications[event] exists → write to the inbox
//      (sent to org owner by default; for user-targeted, use notify() instead)
//   3. Walk APP_REGISTRY and invoke any subscriber's handler
//      (handlers are loaded dynamically from server/src/apps/<slug>/<handler>)
//   4. Record processed_by[] on the event row

// ── Cross-app entity links ──────────────────────────────────────────────
await linkEntities(orgId, {
  from: { app: "smrtcrm",  entity: "contact", id: contactId },
  to:   { app: "smrttask", entity: "task",    id: taskId    },
  type: "created_from",   // "related" | "created_from" | "blocks" | "resolves"
});

// Read what's linked to a given entity (either direction):
const links = await getLinks(orgId, "smrtcrm", contactId);
// → [{ app: "smrttask", entity: "task", id: "...", type: "created_from" }, ...]
```

### Choosing the right channel

| Goal | Channel |
|---|---|
| Surface a user-facing item in the inbox | `notify()` or a manifest `notifications` entry on an emit-event |
| React to something happening in another app | `subscribes` entry in your manifest + handler file |
| Tell the user "something broke and you need to handle it" | `notifyError()` |
| Persist "A in app X is related to B in app Y" for UI breadcrumbs | `linkEntities()` |
| User-to-user push inside an org | `POST /api/messages` (uses `notify()` under the hood) |
| Cross-cutting people/companies data | Shared `contacts` table, with `created_by_app = "smrtcrm"` |

---

## STEP 15 — Environment Variables

No new env vars are needed unless the app calls an external API.
If it does, add them to Railway (server) **and** document them here.

| Variable | Required | Scope | Description |
|---|---|---|---|
| `SMRTCRM_API_KEY` | only if external API | server | Key for the CRM's external data source |

Per-org secrets (e.g., a tenant's own integration token) go in the
Supabase Vault via the `secrets` admin page — never in env vars.

---

## STEP 16 — Pre-Push Review Protocol

Before `git push`, run the full CLAUDE.md protocol. Key items for a new app:

**Step 1 — Real build (not just tsc):**
```
npm install --no-audit --no-fund && npm run build
```

**Step 2 — Targeted greps:**
```bash
# Missing { error } destructuring on DB writes
grep -n "await db.from.*\.\(insert\|update\|upsert\)(" server/src/modules/smrtcrm/routes.ts

# Hardcoded tenant data
grep -rn "1wDog\|noreply@maor\|chanoch\|@maor.org" server/src/modules/smrtcrm/ src/components/smrtcrm/

# CHECK constraints on new tables — make sure your inserts honor them
grep -n "CHECK" supabase/migrations/*smrtcrm*

# Raw fetch to /api — should be zero outside lib/api/client.ts
grep -rn 'fetch(\s*["`]/api' src/components/smrtcrm/ src/app/\[locale\]/\(app\)/\(smrtcrm\)/

# Locale ternaries — should be zero, use t() instead
grep -rn 'locale\s*===\s*"he"' src/components/smrtcrm/ src/app/\[locale\]/\(app\)/\(smrtcrm\)/
```

**Step 3 — Sub-agent code review:** use the prompt in CLAUDE.md → Step 3,
scoped to the diff.

**Step 4 — Update app status** via `PATCH /api/admin/apps/smrtcrm/status`
(see STEP 12).

**Step 5 — Commit hygiene:** see CLAUDE.md.

---

## Complete Launch Checklist

### Database
- [ ] `INSERT INTO apps` migration + initial `app_status` row
- [ ] App tables created with `smrtcrm_` prefix, `org_id` FK, RLS policy,
      `org_id` index
- [ ] No `CHECK` constraints violated by planned inserts
- [ ] If writing to shared `contacts`, sets `created_by_app = 'smrtcrm'`

### Server
- [ ] `server/src/modules/smrtcrm/routes.ts` — every route uses
      `requireAuth + requireOrg + requireApp("smrtcrm")`
- [ ] Any public webhook is mounted at app-root in `server/src/index.ts`
      BEFORE the auth-guarded routers
- [ ] `server/src/modules/smrtcrm/index.ts` — exports default router
- [ ] `server/src/index.ts` — router mounted under `/api`
- [ ] `server/src/apps/smrtcrm/manifest.ts` — created and registered in
      `APP_REGISTRY` (`server/src/lib/platform/registry.ts`)
- [ ] Every `await db.from(...)` write destructures `{ error }` and handles it
- [ ] Every error path calls `notifyError()` AND writes a `log_entries` row
- [ ] Significant domain actions call `emitEvent()`
- [ ] Cross-app references use `linkEntities()`

### Frontend
- [ ] Route group `src/app/[locale]/(app)/(smrtcrm)/` created
- [ ] Components in `src/components/smrtcrm/`
- [ ] No imports from other apps' component folders
- [ ] All strings in `src/messages/en.json` + `src/messages/he.json` under
      `"smrtCRM"` namespace; no `locale === "he" ? ...` ternaries
- [ ] All API calls use `api()` from `@/lib/api/client` — zero raw
      `fetch("/api/...")`
- [ ] Sidebar gated section added behind `enabledApps.includes("smrtcrm")`
- [ ] Guide page at `src/app/[locale]/(app)/(smrtcrm)/<route>/guide/page.tsx`
      using `AppGuideLayout`
- [ ] Guide link in sidebar section

### Admin
- [ ] App visible in `/admin/apps` (automatic after DB insert)
- [ ] `app_status` initialized via `PATCH /api/admin/apps/smrtcrm/status`
- [ ] App enabled for at least one org via `app_memberships`
      (admin UI or seed migration)

### Quality
- [ ] `npm run build` passes with zero new errors
- [ ] Sub-agent code review run; all HIGH/MED findings fixed
- [ ] No hardcoded IDs, emails, folder IDs, account names, or
      `created_by` values outside `('user','claude','system')`

---

## Folder Structure Reference

After adding smrtCRM, the tree looks like this:

```
server/src/
  index.ts                          ← mount: import smrtcrmRouter; app.use("/api", smrtcrmRouter)
  middleware/                       ← requireAuth, requireOrg, requireRole, requireApp, requireSuperAdmin
  lib/
    platform/
      index.ts                      ← exports notify, notifyError, emitEvent, linkEntities, getLinks
      registry.ts                   ← APP_REGISTRY: add smrtcrmManifest here
      notify.ts                     ← notifications writer + error handler resolver
      emit.ts                       ← app_events publisher + subscriber router
      links.ts                      ← entity_links read/write
      types.ts                      ← AppManifest, NotifyParams, LinkType (= 'related'|'created_from'|'blocks'|'resolves')
  routes/
    inbox.ts                        ← /api/inbox  (unified inbox count + list)
    messages.ts                     ← /api/messages (user-to-user push)
    quick-action.ts                 ← /api/quick-action
  modules/
    platform/                       ← platform core (orgs, members, me, apps, secrets, contacts)
    admin/                          ← super-admin routes (orgs, users, apps, app_status, prompts, rules)
    smrttask/                       ← smrtTask module (pattern to follow)
    smrtcrm/                        ← NEW: your app module
      index.ts
      routes.ts
  apps/
    smrttask/manifest.ts            ← existing
    smrtcrm/manifest.ts             ← NEW

src/
  app/[locale]/(app)/
    layout.tsx                      ← auth + onboarding + active-org gate (shared)
    (platform)/                     ← inbox, settings, admin
    (smrttask)/                     ← tasks, projects, calendar, whatsapp, log
    (smrtcrm)/                      ← NEW: your app pages
      crm/page.tsx
      crm/guide/page.tsx
  components/
    ui/                             ← shared primitives
    platform/                       ← layout (Sidebar, OrgSwitcher), inbox, onboarding, AppGuideLayout
    smrttask/                       ← smrtTask components
    smrtcrm/                        ← NEW: your app components
  lib/
    api/client.ts                   ← api() helper (auto-attaches Authorization + X-Org-Id)
    supabase/                       ← client.ts (browser), admin.ts (server, service role)
  messages/
    en.json                         ← add "smrtCRM" namespace + nav keys
    he.json                         ← add "smrtCRM" namespace + nav keys

supabase/migrations/
  20260518000001_platform_integration.sql   ← creates notifications, app_events, entity_links, error_handler_user_id
  20260518000002_app_status_tracker.sql     ← creates app_status
  ..._register_smrtcrm.sql                  ← NEW: INSERT INTO apps + app_status seed
  ..._smrtcrm_schema.sql                    ← NEW: CREATE TABLE smrtcrm_*
```

### Import rules (enforced by convention)
- App code (`modules/smrtcrm`) imports from: `../../db`, `../../middleware`,
  `../../lib/platform`, `../../routes/*` (only if shared infra needed),
  and components from `components/ui/` + `components/platform/`.
- App code **never** imports from another app
  (`modules/smrttask/...`, `components/smrttask/...`).
- This is what makes it trivial to extract an app into its own repo: copy
  `server/src/modules/<slug>`, `server/src/apps/<slug>`,
  `src/app/[locale]/(app)/(<slug>)`, `src/components/<slug>`, and the
  `<slug>` keys from the i18n files.

---

## Architecture Reference — what changed since v1 of this guide

This section captures the platform-level moves the codebase has made.
Read it once to understand the WHY behind the steps above.

### Multi-tenancy is the foundation
Every domain table carries `org_id`. RLS policies always filter by
`org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())`.
A trigger autofills `org_id` on insert from the user's primary org for
tables that opted in (tasks, projects, reminders) — your app's tables
can do the same if useful, but explicit `org_id` from `req.org!.id` in
routes is always preferred.

### App gating is per-org, not per-user
`app_memberships(org_id, app_id)` is the source of truth.
`requireApp("smrtcrm")` blocks 403 if the active org doesn't have the
app enabled. The sidebar reads `enabledApps` (an array of slugs) and
gates whole sections.

### Cross-app contract = SDK, not direct reads
The platform exposes `notify`, `notifyError`, `emitEvent`,
`linkEntities`, `getLinks`. Apps never `SELECT` from each other's
tables. If you need data from another app, subscribe to its events
via your manifest, or store a link via `linkEntities()`.

### Inbox is unified
All cross-app surfacing — user-targeted messages, error reports, async
event-driven prompts — flows into a single `notifications` table.
`/api/inbox` aggregates this together with smrtTask task suggestions
into one feed and one badge count.

### Errors route to a human
`organizations.error_handler_user_id` (configurable, defaults to the
owner) determines who sees `notifyError()` items. Apps don't need to
know who that is; the platform resolves it.

### Super-admin is platform-wide
`super_admins` table + `requireSuperAdmin` middleware gate `/admin/*`.
Independent from per-org roles. The `ADMIN_EMAIL` env var is a
permanent lockout-safety fallback only.

### App development stages are tracked
`app_status` per app, with stages `רעיון → בניה → טסט → מאור → לקוחות`.
Updated via `PATCH /api/admin/apps/<slug>/status` after each push that
materially changes the app's readiness.

### Public webhooks need careful router ordering
Express runs middleware in registration order. If `requireAuth` lives
on a parent router, every child path inherits it. To keep a webhook
public, mount it at the **application** level in `server/src/index.ts`
*above* any auth-guarded router. See PRs #33–#34 for the WhatsApp
saga that taught us this.

### Frontend is a UI layer over the API
Direct Supabase calls from React are limited to: realtime
subscriptions, Supabase Auth flows, and a few admin server-component
reads. Everything else goes through `api()` → Express → service-role
client. This is what makes a future mobile app or external partner
integration possible without duplicating business logic.
