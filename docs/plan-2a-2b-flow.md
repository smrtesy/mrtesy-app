# smrtesy — Plan 2A & 2B: How It Works

## Overview

These two plans make smrtesy smarter about **tasks** (2A) and **projects** (2B).

- **Plan 2A** — Stops duplicate tasks. When a new message is about something already in your task list, the system updates that task instead of creating a new one.
- **Plan 2B** — Connects tasks to projects automatically. The AI learns what each project is about, suggests projects from your task patterns, and lets you verify what it learned.

---

## Plan 2A — Task Update Threading

### The Problem It Solves
Before this, every new email or WhatsApp message about the same topic would create a **brand new task** — even if you already had an open task for it. You'd end up with 5 tasks all about the same grant application, for example.

### How It Works

Every time the system syncs your messages (Gmail, WhatsApp, Calendar, Drive), it runs the **AI Classifier (Part 3)**. This is the brain that reads each new message and decides what to do with it.

With Plan 2A, before creating anything new, the classifier is shown your **currently open tasks** and asks:

> "Is this new message a follow-up to something already open?"

**If YES → Update existing task**
- The new message content is appended to that task's update history
- No new task is created
- You see the update appear in the task's timeline the next time you open it

**If NO → Create new task**
- A new task is created as usual
- It lands in your Suggestions inbox for you to approve

### When Does It Trigger?
- Automatically during every scheduled sync (runs nightly by default)
- Manually when you press "Run Sync" in the Admin panel

### What You See
- In the **task detail panel** (tap ✏️ on any task), there is an **Update History** section showing every AI-detected follow-up in order, with timestamps and source type (email/WhatsApp/etc.)
- Open task count stays clean — no more duplicates piling up

---

## Plan 2B — Project Intelligence

Plan 2B has **four connected parts** that build on each other.

---

### Part B1 — Project Matching During Sync

**What it does:** When the AI classifier creates a new task, it also checks whether that task belongs to one of your active projects.

**How:** The classifier is shown your **active projects with their keywords and key contacts**. For every new task, it decides:
- Does this task mention keywords or people linked to a known project?
- How confident is it? (0–100%)

**If confidence ≥ 70%** → the task is automatically linked to that project (`project_id` is set)  
**If confidence < 70%** → task is saved without a project link (you can set it manually)

**When does it trigger?**  
Same as 2A — every sync, automatic or manual.

**What you see:**  
- On task cards in your task list, a **coloured pill badge** shows the project name
- In the task detail panel, the project name appears under the title
- You can also manually link/change the project via the ✏️ edit button on any task

---

### Part B2 — AI Project Suggestions

**What it does:** The AI analyses all your approved tasks from the last 60 days and finds patterns — groups of tasks that clearly belong together as an ongoing project you haven't named yet.

**How:** It looks for clusters of **3 or more tasks** that share a topic, contact, or goal. For each cluster it finds, it:
1. Suggests a project name (in Hebrew)
2. Lists which tasks belong to it
3. Extracts initial **keywords** and **key contacts** for that project

**When does it trigger?**  
Manually — you run it from the **Admin → Sync** panel by clicking "Run Part 4 Suggest". It is not part of the nightly automatic sync (because it analyses historical data, not just new messages).

**What you see:**  
In **Suggestions → Projects tab**, each AI suggestion appears as a card:
- Project name
- Short description
- ✓ **Create Project** — approves the suggestion, creates the project, links all the clustered tasks to it, and saves the initial keywords/contacts
- ✗ **Dismiss** — rejects the suggestion

---

### Part B3 — Build Brief with AI

**What it does:** For an existing project, this extracts **structured facts** from all the tasks and messages linked to that project — building a knowledge base about it.

**How:** It reads all linked tasks and their source messages (emails, WhatsApp messages), then asks Claude to identify:

| Fact type | Example |
|---|---|
| **Contact** | "Dana Cohen — dana@example.com" |
| **Keyword** | "annual budget", "Q3 report" |
| **Timeline** | "Deadline: April 30", "annual event runs June–August" |
| **Topic** | "funding applications", "government reports" |
| **Link** | "Drive folder: Maor 2025 Budget" |
| **Note** | Any other useful context |

These facts are saved as **Pending Facts** — they are not applied automatically. Every fact waits for your approval.

**When does it trigger?**  
Manually — you press the **"Build Brief with AI"** button on any project detail page. It runs in the background and shows the facts when done (page refreshes after ~2 seconds).

---

### Part B4 — Fact Verification

**What it does:** Lets you review every fact the AI extracted, one by one, before it becomes part of the project's permanent record.

**How:** After "Build Brief" runs, the **fact verification panel** appears at the top of the project page. Each fact shows:
- The fact type (contact, keyword, timeline, etc.) with a coloured icon
- The extracted value
- ✓ **Approve** — saves it permanently; keywords go into the project's keyword list, contacts go into the key contacts list
- ✗ **Reject** — discards it; the AI won't suggest it again for this project

**Why does this matter?**  
Approved keywords and contacts directly improve **Part B1 (Project Matching)**. The richer the project's keyword list, the more accurately the AI links future incoming tasks to the right project automatically.

---

## Full Flow Diagram

```
Every Sync (nightly / manual)
│
├── New message arrives (Gmail / WhatsApp / Calendar / Drive)
│       │
│       ▼
│   Part 3 — AI Classifier
│       │
│       ├── Is this a follow-up to an open task?
│       │       YES → append to task updates (Plan 2A)
│       │       NO  → create new task → goes to Suggestions inbox
│       │
│       └── Does this task belong to an active project? (Plan 2B1)
│               Confidence ≥ 70% → link task to project automatically
│               Confidence < 70% → leave unlinked (manual later)
│
│
On demand (Admin panel)
│
└── Part 4 Suggest → analyse 60 days of tasks → suggest new projects (Plan 2B2)
        User approves → project created with keywords + contacts seeded


On demand (Project page → "Build Brief with AI")
│
└── Part 4 Build Brief → extract facts from linked tasks + messages (Plan 2B3)
        Facts appear as Pending → user verifies one by one (Plan 2B4)
                Approved keywords → improve future auto-matching (feeds back into 2B1)
```

---

## Summary Table

| Feature | Trigger | User action required | Where you see it |
|---|---|---|---|
| Task update threading | Every sync | None | Task detail → Update History |
| Task → project auto-link | Every sync | None | Task card badge / task detail header |
| Manual task → project link | Any time | Tap ✏️ on task | Task detail edit form |
| Project suggestion | Manual (Admin) | Approve or dismiss | Suggestions → Projects tab |
| Build Brief | Manual (project page) | Click "Build Brief with AI" | Project page → fact panel |
| Fact verification | After Build Brief | Approve ✓ or reject ✗ | Project page → pending facts |
| Manual project edit | Any time | Click "Edit" on project | Project detail → Edit sheet |
