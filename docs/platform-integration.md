# Platform Integration Architecture

Cross-app communication, unified inbox, notifications, and error routing for the smrtesy platform.

---

## Core Principle

Apps do not read each other's tables directly. Everything flows through three platform-level
channels: **events**, **notifications/inbox**, and **shared entities**.

```
                    ┌─────────────────────────┐
                    │   Platform (smrtesy)     │
                    │                         │
                    │  contacts (shared)       │
                    │  app_events (bus)        │
                    │  notifications (inbox)   │
                    │  entity_links            │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐       ┌───────▼──────┐      ┌───────▼──────┐
   │  smrtTask   │       │   smrtBot    │      │   smrtCRM    │
   │  manifest   │       │   manifest   │      │   manifest   │
   │  handlers   │       │   handlers   │      │   handlers   │
   └─────────────┘       └──────────────┘      └──────────────┘
```

---

## Platform Tables (defined once, never per-app)

### notifications

Inbox items visible to the user. Written by any app or the platform itself.

```sql
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_slug     text NOT NULL,
  type         text NOT NULL
               CHECK (type IN ('info', 'warning', 'success', 'action_required')),
  title        text NOT NULL,
  body         text,
  link         text,
  entity_type  text,
  entity_id    uuid,
  from_user_id uuid REFERENCES auth.users(id),   -- set when sent by a user
  is_read      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

### app_events

Internal event bus. Apps emit events here; other apps listen and react.

```sql
CREATE TABLE app_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_app   text NOT NULL,
  event_type   text NOT NULL,   -- e.g. 'task.completed', 'lead.detected'
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  processed_by text[] NOT NULL DEFAULT '{}',   -- slugs of apps that already handled this
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

### entity_links

Persistent cross-app references. "This task was created from that conversation."

```sql
CREATE TABLE entity_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_app    text NOT NULL,
  source_entity text NOT NULL,
  source_id     uuid NOT NULL,
  target_app    text NOT NULL,
  target_entity text NOT NULL,
  target_id     uuid NOT NULL,
  link_type     text NOT NULL
                CHECK (link_type IN ('related', 'created_from', 'blocks', 'resolves')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_app, source_id, target_app, target_id)
);
```

---

## Platform SDK — `@/lib/platform`

Every app uses the same three functions. None of them require knowing what other apps exist.

```typescript
import { emitEvent, notify, linkEntities } from "@/lib/platform";

// Emit an event for other apps to react to
await emitEvent(orgId, "smrtbot", "lead.detected", "conversation", convId, {
  customer: "דני כהן",
  company: "אקמה בע\"מ",
  phone: "+972...",
});

// Write a notification to the unified inbox
await notify(orgId, userId, {
  app_slug: "smrtbot",
  type: "action_required",
  title: "פנייה שלא טופלה — דני כהן",
  link: `/smrtbot/conversations/${convId}`,
  entity_type: "conversation",
  entity_id: convId,
});

// Record a cross-app link
await linkEntities(orgId, {
  from: { app: "smrtbot",  entity: "conversation", id: convId },
  to:   { app: "smrttask", entity: "task",         id: taskId },
  type: "created_from",
});
```

---

## The App Manifest

Every app defines a single manifest file at `server/src/apps/<slug>/manifest.ts`.
The platform event router reads all manifests at startup and wires everything automatically.

```typescript
// server/src/apps/smrtbot/manifest.ts
import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtbot",
  name: "smrtBot",

  // Events this app emits into app_events
  emits: [
    "message.unhandled",    // bot could not answer
    "lead.detected",        // visitor identified as a lead
    "conversation.ended",   // conversation closed
  ],

  // Events from other apps this app reacts to
  subscribes: [
    {
      event:   "task.completed",
      source:  "smrttask",
      handler: "./handlers/on-task-completed",
    },
    {
      event:   "contact.updated",
      source:  "platform",
      handler: "./handlers/on-contact-updated",
    },
  ],

  // Which emitted events produce inbox notifications, and how
  notifications: {
    "message.unhandled": {
      type:  "action_required",
      title: (p) => `פנייה שלא טופלה — ${p.customer}`,
      link:  (p) => `/smrtbot/conversations/${p.conv_id}`,
    },
    "lead.detected": {
      type:  "action_required",
      title: (p) => `ליד חדש — ${p.company ?? p.customer}`,
      link:  (p) => `/smrtbot/conversations/${p.conv_id}`,
    },
  },

  // Shared platform entities this app reads or writes
  entities: {
    reads:  ["contacts"],
    writes: ["contacts"],
  },

  // Error handling — who gets task suggestions for technical failures
  errors: {
    // "owner" = org owner (default). Override in org settings → Manage Org.
    default_handler_role: "owner",
    examples: [
      "חיבור WhatsApp API נכשל",
      "Bot webhook לא מגיב",
      "Rate limit חורג",
    ],
  },
};
```

---

## Routing Logic — What Goes Where

When an app emits an event, the platform decides automatically:

```
event emitted
    │
    ├── manifest.notifications[event] defined?
    │       ├── yes → write to notifications
    │       │         type=action_required AND user has smrtTask?
    │       │             ├── yes → also create task suggestion in smrtTask
    │       │             └── no  → inbox card with "סמן כטופל"
    │       └── no  → silent (other apps can still react via subscribes)
    │
    └── other apps subscribed to this event?
            └── yes → call their handler (within the same backend process)
```

### Routing Table by notification type

| type | smrtTask subscriber | no smrtTask |
|---|---|---|
| `action_required` | Appears as task suggestion (approve/reject) | Inbox card "לטיפול" |
| `info` | Inbox card, read-only | Inbox card, read-only |
| `warning` | Inbox card, read-only | Inbox card, read-only |
| `success` | Inbox card, read-only | Inbox card, read-only |

---

## Unified Inbox (`/inbox`)

Replaces the current `/suggestions` page. One screen for every user.

- **Badge** in Sidebar shows total unread (notifications + pending task suggestions).
- **Realtime**: Supabase channel subscribes to `notifications` table, same pattern as today's task count.
- **Source label**: every card shows which app sent it (smrtTask / smrtBot / user avatar).

```
📥 Inbox (5)
├── 🟡 [smrtBot]   פנייה — דני כהן         [אשר כמשימה] [דחה]
├── 🔴 [smrtBot]   ליד — אקמה בע"מ         [אשר כמשימה] [דחה]
├── 🔴 [Platform]  שגיאה: Bot webhook       [אשר כמשימה] [דחה]
├── 💬 [רחל לוי]   "תבדוק את החשבונית"     [אשר כמשימה] [דחה]
└── ℹ️  [smrtBot]   47 שיחות אתמול          [סמן כנקרא]
```

---

## User-to-User Messages (intra-org only)

A user can send an actionable message or an informational note to any member of the same org.
The platform routes it identically to an app notification — the recipient's smrtTask subscription
determines whether it becomes a task suggestion or a plain inbox card.

```typescript
// POST /api/messages
await sendInternalMessage(orgId, {
  from_user_id: currentUserId,
  to_user_id:   targetUserId,
  type:         "action_required",   // or "info"
  title:        "תבדוק את החשבונית של אקמה",
  link:         "/smrtbot/conversations/123",   // optional
});
```

Rules:
- `from_user_id` and `to_user_id` must both be members of `org_id`.
- The sender does not need to know whether the recipient has smrtTask — the platform handles routing.
- No threading, no chat. One-way pushes only. For back-and-forth, use task comments.

---

## Technical Error Handling

When any app catches a technical failure (sync crash, API timeout, webhook unreachable),
it should call `notifyError()` instead of (or in addition to) writing to `log_entries`.

```typescript
import { notifyError } from "@/lib/platform";

await notifyError(orgId, "smrtbot", {
  title: "Bot webhook לא מגיב",
  body:  `POST ${webhookUrl} → 503 (attempt 3/3)`,
  link:  "/settings/smrtbot/connections",
});
```

`notifyError` internally:
1. Looks up `org_error_handler_user_id` from `organizations` (defaults to owner).
2. Writes a notification with `type: "action_required"`.
3. If the handler user has smrtTask → creates a task suggestion automatically.

### Configuring the error handler

Default: org owner.

Override in **Manage Org → שגיאות טכניות → assign to user**.
Stored as `organizations.error_handler_user_id`.

Any org member with role `owner` or `admin` can change this setting.

---

## Shared Entities — contacts

`contacts` is a platform-level table (not owned by any app). Any app can read and write.

When writing, always set `created_by_app`:

```typescript
await supabase.from("contacts").insert({
  org_id:          orgId,
  name:            "דני כהן",
  email:           "dani@example.com",
  phone:           "+972...",
  created_by_app:  "smrtbot",
});
```

When reading, no filter on `created_by_app` — all apps see all contacts for the org.

---

## Real-World Example — smrtBot Full Flow

```
1. Customer messages WhatsApp → smrtBot receives

2. Bot cannot answer
   → emitEvent(orgId, "smrtbot", "message.unhandled", "conversation", convId, { customer: "דני כהן" })

3. Platform router reads manifest:
   → notifications["message.unhandled"] defined → write to notifications (action_required)
   → user has smrtTask → create task suggestion: "טפל בפנייה של דני כהן"

4. Badge in Sidebar increments

5. Operator opens inbox, approves → Task created in smrtTask

6. smrtTask emits "task.completed"
   → smrtBot handler "on-task-completed" fires
   → Bot sends WhatsApp to customer: "פנייתך טופלה ✓"

7. entity_links: smrtbot/conversation/<id> ↔ smrttask/task/<id>
   → Task detail page can show "נוצר משיחת בוט עם דני כהן"
```

---

## Implementation Order

Build in this sequence so each layer is useful on its own:

1. **`notifications` table + `/inbox` page + Sidebar badge** — value from day one
2. **`notifyError()` + org error handler setting** — replaces silent failures
3. **User-to-user messages** — `POST /api/messages`
4. **`app_events` table + manifest schema + event router** — needed when second app exists
5. **`entity_links`** — add when cross-app UI context is needed
6. **Shared `contacts`** — migrate existing per-app contacts when second app that needs them ships
