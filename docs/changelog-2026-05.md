# smrtesy — Development Changelog
**Period covered:** April–May 2026
**Branch:** `feature/multi-tenant`

This document summarises every change shipped since the last update. It's organised by feature theme rather than chronologically so it's easy to scan.

---

## 1. Smarter Task Management

### 1.1 Task Update Threading (Plan 2A)
**Problem solved:** Before this, every new email/WhatsApp about the same topic created a brand-new task — you'd end up with 5 tasks all about the same grant application.

**What now happens:** When a new message arrives, the AI classifier first checks your **currently open tasks**. If it's a follow-up to something already open, it appends an update entry to that task instead of creating a duplicate. The new content shows up in the task's **Update History** with a timestamp and the source (email/WhatsApp/etc.).

**Trigger:** Every scheduled sync, automatic.

### 1.2 Project Intelligence (Plan 2B)

Four connected pieces that learn what each project is about and link new tasks to the right one automatically.

| Feature | What it does | When it runs |
|---|---|---|
| **Auto project matching** | New tasks get linked to the right project when AI is ≥70% confident, based on keywords + key contacts | Every sync |
| **AI project suggestions** | Analyses last 60 days of tasks, suggests clusters of 3+ related tasks as new projects | Manual (Admin → Sync) |
| **Build Brief with AI** | Extracts structured facts (contacts, keywords, timelines, links) from a project's tasks + messages | Manual button on each project page |
| **Fact verification** | User approves/rejects each extracted fact one by one; approved keywords/contacts feed back into matching | After Build Brief runs |

The more facts you verify, the more accurately the AI links future incoming items to the right project.

### 1.3 Task UI improvements
- **Manual project link** — task edit form has a Project dropdown to manually link/relink a task to any project
- **Project badge on task cards** — every task card shows a coloured pill with the project name
- **Project info shown in task detail panel** — the linked project appears as a chip below the title
- **Task assignment** — task edit form has an Assignee dropdown listing every org member

### 1.4 Project page improvements
- **Edit Project sheet** — comprehensive edit panel that updates name, color, keywords, key contacts, and brief fields (purpose, target audience, current status, AI context) in one place
- **Verified facts list** — green-checkmarked facts displayed inside the brief card
- **Keywords + key contacts** shown as chips at the top of every project page

---

## 2. Multi-Tenant Platform Foundation

The biggest change in this period — the app went from a single-user tool to a multi-tenant platform that can host multiple apps for multiple organizations.

### 2.1 New tenancy model
- **Organizations** — every team gets its own workspace. Tasks, projects, contacts, and messages all live inside an org.
- **Members + Roles** — each org has owners, admins, and members. Owners can manage everything; admins can manage members + apps; members can work with tasks.
- **App entitlements** — each org has a set of "installed apps." smrtesy is the first app. Future apps (CRM, Coach, etc.) plug in the same way.

### 2.2 Backward-compatible migration
Every existing user automatically got a "Personal" workspace created for them. All their existing tasks and projects were stamped with that workspace's ID. **Zero data loss; everyone keeps working.**

### 2.3 Workspace switcher
- Sidebar dropdown shows all workspaces you belong to
- Switch between workspaces with one click (all data reloads scoped to the new workspace)
- Create new workspaces from the dropdown

### 2.4 Member management
- New page at **Settings → Manage organization & members** (`/settings/org`)
- Owner/admin can invite by email (user must have signed up first)
- Inline role change dropdown
- Remove members (with last-owner protection)

### 2.5 Per-organization app gating
Each org's set of enabled apps gates which features are available:
- An org with `smrtesy` enabled → AI sync, classifier, project suggestions, brief builder all work
- An org without `smrtesy` enabled → base features still work (tasks, members, messaging), but AI sync routes return 403

This means a future "Sales-only" org could subscribe just to a CRM app without paying for the AI brain.

---

## 3. Workspace Onboarding

New first step in the signup flow.

```
Before: sign up → Gmail → Drive → WhatsApp → Setup
After:  sign up → "Create your workspace" → Gmail → Drive → WhatsApp → Setup
                       ↑ NEW
```

**The new step:**
- Suggests a default workspace name from the user's full name or email
- User confirms or changes it
- Creates the organization, makes the user the owner
- Enables smrtesy for the workspace automatically
- Continues into the existing connection flow

**Smart fallback:** Existing users who refresh during onboarding skip this step (they already have a workspace from the migration).

---

## 4. Super-Admin Console

A platform-wide admin role for support, billing, and policy management — independent of per-org roles.

### 4.1 Identity model
- New `super_admins` table — a user can have super-admin status while also being a regular member of their own orgs
- DB-backed and managed via API; the `ADMIN_EMAIL` env var stays as a permanent lockout-safety fallback

### 4.2 Admin Console pages (under `/admin`)

| Page | What it does |
|---|---|
| **Dashboard** | (existing) user count, AI cost, sync health |
| **Users** | (existing) list of all users with connections + settings |
| **User detail** | **NEW** sections at top: effective app access, every org the user belongs to (with apps), add to org, remove from org, change role |
| **Organizations** | **NEW** every org in the system + member count, owner email, enabled apps |
| **Org detail** | **NEW** rename org, "Open as this org" support button, member management, app toggle switches, hard-delete with double confirm |
| **Apps Registry** | **NEW** every registered app + how many orgs use each; register new apps, edit, unregister |
| **Super Admins** | **NEW** grant/revoke super-admin by searching users; protected against last-admin self-revoke |
| Services / Logs / Prompts / Rules / Sync | (existing) smrtesy operational pages |

### 4.3 App access management for super-admins
Two ways to grant a user access to an app:
1. From `/admin/orgs/[id]` — toggle the app on for an org they're in
2. From `/admin/users/[id]` — add them to an org that already has the app

Either path shows the user the same outcome on their "Effective App Access" view.

### 4.4 Audit-friendly
Every grant/enable records `granted_by`, `granted_at`, `enabled_by`, `enabled_at` for accountability.

---

## 5. Architecture & Code Quality

### 5.1 Express backend grew into a real platform
A standalone Express backend now owns all business logic. The Next.js frontend is now mostly a UI layer — it calls REST endpoints rather than talking to the database directly.

**Why this matters:** Future apps (CRM, Coach, mobile app) can hit the same backend API without rewriting business logic.

### 5.2 Frontend migration from direct DB to API
Roughly 12 client-side components were migrated from direct Supabase queries to the new backend API:
- Task list / detail / quick-action / drive-search / smart-input / AI-clarification
- Project creation / edit / suggestions / brief approval / fact verifier
- Sidebar suggestion-count badge
- Reminders inbox

The only direct-Supabase calls remaining are:
- **Realtime subscriptions** (intentional — keeps live updates instant)
- **Auth flows** (intentional — Supabase Auth handles login/signup)
- **Server-component reads on admin pages** (intentional — server-side with RLS protection)

### 5.3 AI pipeline became org-aware
Part 3 (classifier) and Part 4 (project suggester / brief builder) now scope every query by `organization_id`. A user in multiple orgs can switch workspaces and the AI only sees their active workspace's data.

### 5.4 Middleware stack
A clean four-piece middleware chain gates every API call:
- `requireAuth` — verifies the user's session token
- `requireOrg` — verifies the user belongs to the workspace they're operating in
- `requireRole(...)` — gates by role (owner/admin/member)
- `requireApp(slug)` — gates by which apps the workspace has enabled
- `requireSuperAdmin` — gates platform-admin routes

---

## 6. Database migrations applied

| File | What it changed |
|---|---|
| `20260507000001_project_enrichment.sql` | Added `keywords`, `key_contacts` to projects; `pending_facts`, `verified_facts`, `rejected_facts` to project_briefs; `project_confidence` to tasks |
| `20260510000001_platform_foundation.sql` | Created `organizations`, `org_members`, `apps`, `app_memberships`; added `assigned_to_user_id` on tasks; backfilled Personal org for every existing user |
| `20260510000002_org_id_autofill.sql` | Trigger that auto-fills `organization_id` on task/project insert from the user's primary org |
| `20260510000003_fix_org_members_rls.sql` | Fixed an infinite-recursion bug in the `org_members` RLS policy |
| `20260510000004_reminders_org_id.sql` | Added `organization_id` to `reminders` + trigger + backfill |
| `20260510000005_messaging.sql` | Created `conversations`, `conversation_members`, `messages` tables for in-app messaging |
| `20260513000001_super_admins.sql` | Created `super_admins` table; bootstrapped from `ADMIN_EMAIL` env |
| `20260513000002_super_admins_self_read.sql` | Allowed each user to read their own super-admin status (needed for the admin layout) |

---

## 7. Messaging system (backend ready, UI pending)

The complete backend for in-app messaging between teammates was built:
- 1-on-1 direct messages
- Group conversations (3+ members)
- Message history with pagination
- "Mark as read" with per-user `last_read_at`
- Realtime-ready (Supabase realtime fires on inserts)

The frontend pages for inbox + chat thread view are **not yet built**. Could be shipped in a separate sprint.

---

## 8. Known gaps / next iteration

These were deliberately deferred and are good candidates for the next sprint:

1. **Messaging UI** — backend is ready; needs inbox page + thread view
2. **Email-based invites with magic link** — currently inviting requires the user to have already signed up. A `pending_invites` table + email flow would close this gap.
3. **Per-app trial / expiration** — `app_memberships` doesn't yet support time-bound entitlements
4. **Audit log** — beyond `enabled_by`/`granted_by` columns, no full audit log of admin actions exists
5. **Notifications** — assigning a task to a teammate doesn't notify them yet
6. **Mobile push notifications** — none

---

## 9. Statistics

- **Backend endpoints shipped:** ~60 new REST endpoints across 8 modules
- **Frontend pages:** 6 new admin pages, 1 new onboarding step, 1 new settings page, multiple component overhauls
- **DB migrations:** 8 (all backward-compatible)
- **Documentation:** This file + `docs/plan-2a-2b-flow.md`
- **Test status:** All TypeScript checks pass; no runtime tests added in this period

---

## Quick demo flow for stakeholders

1. **Sign up with a new email** → "Create your workspace" step → name your org → continue into Gmail/Drive connection
2. **Open the workspace** → sidebar shows the workspace name in a dropdown
3. **Settings → Manage organization & members** → invite a teammate by email
4. **Edit a task** → see the new Project + Assignee dropdowns
5. **Open a project** → click "Edit" → notice keywords + key contacts management
6. **Click "Build Brief with AI"** → wait ~10 seconds → approve the extracted facts one by one
7. **Sign out, sign in as a super-admin** → Admin link appears in sidebar
8. **Admin → Organizations** → click any org → toggle apps on/off
9. **Admin → Apps** → register a new fake app (e.g. "test-crm") → see it appear in the org detail page's toggle list
10. **Admin → Super Admins → Grant** → promote another user
