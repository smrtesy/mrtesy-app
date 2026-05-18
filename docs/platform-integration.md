# Platform Integration Architecture

How smrtesy apps communicate, share data, and surface notifications to users.

---

## Overview

The platform provides four integration primitives:

| Primitive | Function | When to use |
|---|---|---|
| `notify()` | Send a notification to a specific user | Direct user-facing alerts, messages |
| `notifyError()` | Send a technical error to the org's error handler | App failures that need human attention |
| `emitEvent()` | Publish a domain event to the event bus | Cross-app data sharing, workflow triggers |
| `linkEntities()` | Create a typed relationship between two entities | CRM contact → task, document → project |

All primitives are server-side only. Import from `server/src/lib/platform/`.

---

## Database Tables

### `notifications`

Stores user-facing alerts from any app.

```sql
id, org_id, user_id, app_slug,
type TEXT CHECK (type IN ('info','warning','success','action_required')),
title, body, link,
entity_type, entity_id,   -- optional link to a specific entity
from_user_id,             -- set for user-to-user messages
is_read BOOLEAN DEFAULT false,
created_at
```

**RLS**: user can read/update only their own rows.

### `app_events`

Immutable event log. Apps publish here; the platform routes to subscribers.

```sql
id, org_id, source_app, event_type, entity_type, entity_id,
payload JSONB,
processed_by TEXT[],     -- manifests that have already processed this event
created_at
```

**RLS**: client access fully denied. Server-side only.

### `entity_links`

Cross-app entity relationships.

```sql
id, org_id,
source_app, source_entity_type, source_id,
target_app, target_entity_type, target_id,
link_type TEXT CHECK (link_type IN ('related','created_from','blocks','resolves')),
created_at
UNIQUE (source_app, source_id, target_app, target_id)
```

---

## App Manifest

Every app declares its integration surface in `server/src/apps/<slug>/manifest.ts`:

```typescript
import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtcrm",
  name: "smrtCRM",

  // Events this app publishes
  emits: ["contact.created", "contact.updated", "deal.closed"],

  // Events from other apps this app wants to handle
  subscribes: ["task.completed"],

  // Notifications triggered by specific event types
  // key = event_type, value = notification template
  notifications: {
    "deal.closed": {
      type: "success",
      title: "Deal closed",    // i18n key or literal
      body:  "A deal was closed in smrtCRM",
    },
  },

  // Entity types this app reads from / writes to other apps
  entities: {
    reads:  ["tasks"],      // reads task entities from smrtTask
    writes: ["contacts"],   // writes contact entities to smrtCRM
  },

  errors: {
    default_handler_role: "owner",
    examples: ["API sync failure", "Webhook parse error"],
  },
};
```

Register the manifest in `server/src/lib/platform/registry.ts`:

```typescript
import { manifest as smrtcrmManifest } from "../../apps/smrtcrm/manifest";
export const APP_REGISTRY: AppManifest[] = [smrttaskManifest, smrtcrmManifest];
```

---

## SDK Usage

### notify() — send a notification to a user

```typescript
import { notify } from "../lib/platform";

await notify(orgId, targetUserId, {
  app_slug: "smrtcrm",
  type:     "action_required",
  title:    "New lead needs review",
  body:     "Maor Cohen submitted a contact form",
  link:     `/crm/leads/${leadId}`,
});
```

### notifyError() — route a technical error to the org's error handler

```typescript
import { notifyError } from "../lib/platform";

await notifyError(orgId, "smrtcrm", {
  title: "CRM sync failed",
  body:  `Could not sync contacts: ${err.message}`,
  link:  `/settings/smrtcrm/sync`,
});
// Routes to org.error_handler_user_id, falls back to org owner
```

### emitEvent() — publish a domain event

```typescript
import { emitEvent } from "../lib/platform";

await emitEvent(
  orgId,
  "smrtcrm",          // source app
  "deal.closed",      // event type (must be in manifest.emits)
  "deal",             // entity type
  dealId,             // entity ID
  { value: 50000, currency: "USD" },   // payload
);
// Platform auto-checks manifest.notifications and calls notify() for matching events
```

### linkEntities() — create a cross-app relationship

```typescript
import { linkEntities } from "../lib/platform";

await linkEntities(orgId, {
  source_app:         "smrtcrm",
  source_entity_type: "contact",
  source_id:          contactId,
  target_app:         "smrttask",
  target_entity_type: "task",
  target_id:          taskId,
  link_type:          "created_from",
});
```

### getLinks() — read cross-app relationships

```typescript
import { getLinks } from "../lib/platform";

const links = await getLinks(orgId, "smrtcrm", contactId);
// [{ app: "smrttask", entity: "task", id: "...", type: "created_from" }]
```

---

## Notification Routing Rules

| Situation | Where it appears |
|---|---|
| User has smrtTask | Technical errors appear as task suggestions in the inbox |
| User does not have smrtTask | Technical errors appear as `action_required` notifications |
| User-to-user message | Always appears as a notification (type set by sender) |
| `emitEvent()` with matching `manifest.notifications` key | Auto-routed to org error handler as notification |

**Error handler fallback chain**: `org.error_handler_user_id` → `org.created_by` (owner).
Owner or admin can reassign in **Settings → Organization → Technical Error Handler**.

---

## User-to-User Messaging

Intra-org only. Both sender and recipient must be members of the same org.

```
POST /api/messages
{
  "to_user_id": "<uuid>",
  "type": "action_required" | "info",
  "title": "Please review this contract",
  "body": "I've attached the updated version",
  "link": "/projects/123"
}
```

The message appears as a notification to the recipient with `from_user_id` set.

---

## Inbox Architecture

`/inbox` replaces the old `/suggestions` page (which now redirects).

- **Tab "הצעות / Suggestions"** — shown only for smrtTask users. Renders task suggestions from the `tasks` table (`status=inbox`, `verified=false`).
- **Tab "התראות / Notifications"** — shown for all users. Renders the `notifications` table, filtered by `user_id` + `org_id`. Realtime via Supabase channel.

The sidebar badge (`/api/inbox/count`) counts both pending suggestions and unread notifications combined.

---

## Integration Checklist (new app)

- [ ] Create `server/src/apps/<slug>/manifest.ts`
- [ ] Register manifest in `server/src/lib/platform/registry.ts`
- [ ] Call `notifyError()` in every catch block that affects the user
- [ ] Call `emitEvent()` for every significant domain action
- [ ] Call `linkEntities()` when creating cross-app references
- [ ] Decide which events to list in `subscribes` and wire up handlers in `emitEvent()` dispatcher
- [ ] Decide which notification types to define in `manifest.notifications`
- [ ] Answer the 4 integration questions below before starting
