# Info & Task Manager v5 — n8n Build Brief

> **This document is for Claude Code.** Read fully before starting. Ask user to confirm any ambiguity. This is the complete specification — do not invent details.

---

## 0. Quick Orientation

- **User:** Chanoch Chaskind, nonprofit Maor/MyMaor
- **Email:** chanoch@maor.org (+ chanoch@kinus.info)
- **Signature:** "משיח נאו!"
- **Project:** Migrating an automated task management system from Claude Code + MCP (fragile, crashes) to **n8n** (visual, monitorable, robust)
- **Existing assets to preserve:** Notion workspace, Netlify web app, Google Drive folder, Gmail accounts
- **Language:** User messages are often in Hebrew; all explanations to user must be Hebrew. n8n UI remains English.

---

## 1. Prerequisites (User Must Confirm Before You Start)

### 1.1 n8n access
- n8n instance URL: **ASK USER**
- n8n API key or login credentials: **ASK USER**
- MCP server installed locally: recommend **czlonkowski/n8n-mcp** — if not installed, instruct user to run `npm install -g n8n-mcp` and add to Claude Code config

### 1.2 Required credentials in n8n (to be set up once)
User should confirm these exist in n8n → Credentials. If missing, pause and ask user to create via OAuth flows in n8n UI.

| Name | Type | Purpose |
|---|---|---|
| `Gmail OAuth — Chanoch` | Gmail OAuth2 | chanoch@maor.org |
| `Gmail OAuth — Kinus` | Gmail OAuth2 | chanoch@kinus.info |
| `Google Drive OAuth` | Drive OAuth2 | Access ScanSnap folder |
| `Google Calendar OAuth` | Calendar OAuth2 | chanoch770@gmail.com |
| `Google Sheets OAuth` | Sheets OAuth2 | For audit log |
| `Notion API` | Notion API | Token: user must paste (integration name: "Task Manager App") |
| `Anthropic API` | HTTP Header Auth | x-api-key with user's key |

### 1.3 Existing Notion IDs (already created, do not recreate)

**Parent page:** `3476d2bc-5eb3-81b6-94f5-d4a160023961`

| Database | Database ID | Data Source (collection) ID |
|---|---|---|
| Tasks | `302a9ffb9d034b548f6c57c5f7cf60c8` | `3d956725-ac6b-4ddf-ba1d-11ed549e4d3e` |
| Projects | `d7d5e4d08ef547ec9c050fd97f0bbeb8` | `a2b5784f-ae5e-44d4-a813-0483cd5393ed` |
| Contacts | `7dc1dc18ff384e7891337373135adb2c` | `c76a052e-0dc0-4917-bd6a-dcc1ff4cbcce` |
| Rules & Memory | `dc610a5a65584f61af0f06bff93542a1` | `e81b85f8-a3d4-48aa-bed9-524053a75859` |
| Run Sessions | `d75ba7caa0a349ed9c5dc49488cbeea2` | `7525ff81-ccb8-4fe6-bbef-9f8afad15190` |
| Action History | `a32511ad0f254853a343632fc5fa9121` | `d9ad2735-af9f-4233-9eba-f6f2b1936da0` |

**NOTE:** The old `Processing Log` Notion DB (`270d5f6d0549453da57ec0456750ca09`) will be **replaced by a Google Sheet** per user's decision. Leave it as-is for now; it serves as reference data during migration.

### 1.4 Other existing data

- **Google Drive ScanSnap folder ID:** `1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1`
- **WhatsApp CSV Sheet ID:** `1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI` (tab: `Messages`)
- **Chava (secretary) phone:** +17326660770

---

## 2. Architecture Overview

```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐
│   Sources   │    │  AUDIT LOG  │    │ ACTIVE DATA  │
│             │    │  (Sheets)   │    │   (Notion)   │
│  Gmail x2   │───►│ Processing  │───►│    Tasks     │
│  Drive      │    │ Log         │    │   Projects   │
│  Calendar   │    │ Run Sessions│    │   Contacts   │
│  WhatsApp   │    │ Actions Hist│    │ Rules+Memory │
└─────────────┘    └─────────────┘    └──────────────┘
                          ▲                    ▲
                          │                    │
                   ┌──────┴────────────────────┴─────┐
                   │          n8n Workflows          │
                   │  1. Collector  2. WhatsApp      │
                   │  3. Classifier 4. Executor      │
                   │  5. Error Handler               │
                   └─────────────────────────────────┘
                                     ▲
                                     │
                            ┌────────┴────────┐
                            │   User's App    │
                            │ (Netlify, reads │
                            │  Notion Tasks)  │
                            └─────────────────┘
```

### Storage decisions (FINAL)
- **Google Drive:** Source PDFs only (unchanged)
- **Gmail:** Source emails only (unchanged)
- **Google Sheets NEW:** Processing Log + Run Sessions + Action History (audit data — easy to export/filter)
- **Notion:** Tasks + Projects + Contacts + Rules & Memory (active data — rich UI, existing app)

### Model selection (FINAL)
- **Haiku 4.5** (`claude-haiku-4-5-20251001`): spam check in Workflow 1
- **Sonnet 4.6** (`claude-sonnet-4-6`): almost everything else — classifier, WhatsApp analyzer, OCR, drafting
- **Opus 4.7** (`claude-opus-4-7`): ONLY for `financial_advisor` with complex scenarios and `call_preparation` for legal calls

### Optimizations (FINAL — user approved)
- ✅ **Prompt Caching** on all AI calls with `cache_control: "ephemeral"` for system prompts
- ✅ Model right-sizing (above)
- ✅ Partial JSON output (structured fields + prose Description)
- ❌ No Batch API (too slow for deadlines)
- ❌ No Raw Content truncation (financial/legal details often mid-document)
- ❌ No auto hard rules (only AI suggestions; user must approve via app's 🚫 חסום button)

---

## 3. Google Sheet Schema (CREATE THIS FIRST)

Create a new Google Sheet titled **"Task Manager Audit"** in user's Drive (ask user for folder or create at root).

Get Sheet ID after creation; document it here once known.

### Tab 1: `Processing Log`

| # | Column | Type | Notes |
|---|---|---|---|
| A | `Timestamp` | datetime | When row was added |
| B | `Source` | text | gmail / drive / whatsapp / calendar |
| C | `Source ID` | text | Unique ID from source (msg ID, file ID, event ID) |
| D | `Source Link` | text (URL) | Direct link to item |
| E | `From` | text | Sender (email/phone) |
| F | `Direction` | text | incoming / outgoing |
| G | `Date Received` | datetime | Actual receive date |
| H | `Subject or Summary` | text | Short title |
| I | `Raw Content` | text | Full content (for PDFs: OCR output) |
| J | `Attachments Info` | text | File sizes, types |
| K | `Reply To Context` | text | If reply, the quoted context |
| L | `Triage Status` | text | pending_deep_classify / classified / skipped_spam / skipped_hard_rule |
| M | `Classification` | text | ACTIONABLE / INFORMATIONAL / SKIPPED_SPAM / pending_classify |
| N | `Classification Reason` | text | Why it was classified this way (for audit) |
| O | `Task ID` | text | Notion Task ID if one was created |
| P | `Action Taken` | text | task_created / logged_only / skipped |
| Q | `Processed At` | datetime | When Workflow 3 finished with it |
| R | `Your Feedback` | text | User's manual feedback field |
| S | `Feedback Processed` | text | YES / NO |

### Tab 2: `Run Sessions`

| # | Column | Type | Notes |
|---|---|---|---|
| A | `Run ID` | text | UUID or timestamp |
| B | `Run Type` | text | COLLECTOR / WHATSAPP / CLASSIFIER / EXECUTOR |
| C | `Started At` | datetime | |
| D | `Ended At` | datetime | |
| E | `Duration Seconds` | number | |
| F | `Status` | text | running / completed / partial / failed |
| G | `Items Processed` | number | |
| H | `Tasks Created` | number | |
| I | `Errors Count` | number | |
| J | `Error Log` | text | Truncated errors |
| K | `Summary` | text | Free-form notes |
| L | `Model Used` | text | haiku / sonnet / opus / mixed |

### Tab 3: `Action History`

| # | Column | Type | Notes |
|---|---|---|---|
| A | `Timestamp` | datetime | |
| B | `Task ID` | text | Notion Task ID |
| C | `Action Type` | text | draft_reply_he, send_email, etc. |
| D | `Status` | text | success / failure |
| E | `Result` | text | Output (e.g., draft link, message sent) |
| F | `Error` | text | If failed |
| G | `Retry Count` | number | |
| H | `Model Used` | text | |
| I | `Tokens In` | number | |
| J | `Tokens Out` | number | |

---

## 4. Workflow 1: Email + Drive + Calendar Collector

**Purpose:** Scan new items from Gmail (2 accounts), Drive ScanSnap folder, and Calendar. Filter spam. Write to Processing Log.

**Schedule:** `0 13,18,23 * * *` (9:00, 14:00, 19:00 NYC — UTC+5/4)

### Nodes (in order):

1. **Schedule Trigger** — cron above
2. **Set Variables** — `lastRunTimestamp` (fetch from last row in Run Sessions where Run Type=COLLECTOR), `currentRunId` (UUID)
3. **Create Run Session (Sheets)** — append to Run Sessions with status=running
4. **Branch: Three parallel paths** via Merge node at end:

#### Path A: Gmail Scan
- **Gmail Node — Chanoch account:** Get Many Messages
  - Filters: `after:{{lastRunTimestamp}} -in:drafts -label:DRAFT`
  - Max: 50
- **Gmail Node — Kinus account:** same but different credential
- **Set Node:** normalize fields — `{source: 'gmail', sourceId: id, sourceLink: 'https://mail.google.com/mail/u/0/#inbox/' + id, from: headers.From, subject: headers.Subject, date: headers.Date, body: decodedBody}`
- **IF Node — Hard Rules:**
  - Skip if `from` matches: `outbox@maor.org`, `office@maor.org`, `officetest@maor.org`, `*@mail.anthropic.com/no-reply*`, any from list in Rules & Memory (skip category)
  - Skip branch: Append to Processing Log with `Triage Status=skipped_hard_rule`, reason column explains which rule matched
  - Continue branch: proceed to spam check

#### Path B: Drive Scan
- **Drive Node:** Search files
  - Query: `'1wDogvxjUfBYSNcd3z9zSwfdvtQVqCw-1' in parents and modifiedTime > '{{lastRunTimestamp}}'`
  - Max: 20
- **Drive Node (per item):** Download file content (PDF)
- **Anthropic Node — OCR (if image/PDF):** Sonnet model, vision-enabled, prompt: "Extract all text from this scanned document. If Hebrew, preserve Hebrew. Output plain text."
  - Use `cache_control: ephemeral` on system prompt
- **Set Node:** normalize — `{source: 'drive', sourceId: fileId, sourceLink: webViewLink, from: '(unknown)', subject: fileName, date: modifiedTime, body: ocrText}`

#### Path C: Calendar Scan
- **Calendar Node:** List Events
  - Time range: now-3d to now+7d
  - Max: 30
- **Set Node:** normalize — `{source: 'calendar', sourceId: eventId, sourceLink: htmlLink, from: organizer, subject: summary, date: start.dateTime, body: description + location + attendees}`

#### Merge & Spam Check
5. **Merge Node:** combine A + B + C into single stream
6. **Split In Batches:** size 5 (for cache efficiency)
7. **Anthropic Node — Spam Check** (Haiku):
   - System prompt (cached): spam detection rules. See §10.1.
   - User prompt: subject + from + first 500 chars of body
   - Output: `{is_spam: bool, reason: "..."}`
8. **IF Node — is_spam?**
   - Yes: Append to Processing Log with `Triage Status=skipped_spam`, `Classification=SKIPPED_SPAM`, `Classification Reason=reason`
   - No: Append to Processing Log with `Triage Status=pending_deep_classify`, `Classification=pending_classify`
9. **Update Run Session (Sheets):** status=completed, counts, endedAt

### Error Handling
- `Continue On Fail` enabled on all external service nodes
- Errors go to Error Workflow (see §8)

---

## 5. Workflow 2: WhatsApp Analyzer

**Purpose:** Analyze recent WhatsApp conversations from the CSV sheet, identify action-needing conversations, write to Processing Log.

**Schedule:** `20 13,18,23 * * *` (offset 20 min after Workflow 1)

### Nodes:

1. **Schedule Trigger**
2. **Create Run Session** (Run Type=WHATSAPP)
3. **Google Drive Node:** Download CSV
   - File ID: `1_0hZE_gTzAyN-DHWhaxSQEnF4tJm1XL6nFUSJngtuaI`
   - Export as CSV (`exportMimeType: 'text/csv'`)
4. **Code Node (JavaScript):** Parse CSV, filter last 48 hours, group by conversation partner
   - Output: array of `{partnerPhone, partnerName, messages: [{timestamp, direction, body}]}`
5. **IF Node — Hard Rules:**
   - Skip if partner phone in: `15551367977`, `972552770695`, and any others from Rules & Memory
   - Skip branch: log to Sheets as `skipped_hard_rule`
6. **Split In Batches:** size 3
7. **Anthropic Node — Conversation Classifier** (Sonnet):
   - System prompt (cached): see §10.2
   - User prompt: formatted conversation
   - Output JSON: `{classification: NEEDS_RESPONSE|WAITING_REPLY|PERSONAL_REMINDER|CLOSED|NOISE, summary_he: "...", urgency: low|medium|high|urgent}`
8. **IF Node — actionable?** (NEEDS_RESPONSE / PERSONAL_REMINDER)
   - Yes: append to Processing Log as `pending_deep_classify`
   - No: append as `classified`, `INFORMATIONAL`
9. **Update Run Session**

---

## 6. Workflow 3: Deep Classifier (THE CRITICAL ONE)

**Purpose:** Take pending items from Processing Log and create Tasks in Notion with enrichment.

**Schedule:** `10 13,18,23 * * *` (offset 10 min — so Collector writes, Classifier reads)

### Nodes:

1. **Schedule Trigger**
2. **Create Run Session** (Run Type=CLASSIFIER)
3. **Google Sheets Node — Read Pending:**
   - Sheet: Processing Log
   - Filter: `Triage Status = pending_deep_classify`
   - **This is the key capability we couldn't do before.** Sheets filter is exact match — returns all pending items in ONE call.
4. **Notion Node — Read Rules & Memory** (once per run):
   - Data source: `e81b85f8-a3d4-48aa-bed9-524053a75859`
   - Returns skip rules, writing_style_he, writing_style_en, category patterns
5. **Set Node:** stash rules in workflow state for reuse
6. **Split In Batches:** size 5 (small batches for cache window of 5 min)
7. **For each item:**

   7a. **Anthropic Node — Deep Classify** (Sonnet):
   - Model: `claude-sonnet-4-6`
   - System prompt (cached — see §10.3): full classification instructions + 18-action catalog + writing_style references + skip rules
   - User prompt: just the item (From, Subject, Raw Content, Reply To Context)
   - Max tokens: 1500
   - Output JSON (structured):
     ```
     {
       "classification": "ACTIONABLE" | "INFORMATIONAL",
       "reason_he": "short reason in Hebrew",
       "task": {
         "title_he": "...",
         "priority": "urgent|high|medium|low",
         "due_date": "YYYY-MM-DD or null",
         "description_he": "RICH PROSE with numbers, dates, contacts, stakes",
         "contact_person": "...",
         "category": "maor|personal",
         "tags": ["payments", "legal", ...],
         "suggested_actions": ["action_name", ...],
         "linked_project": "project name or null"
       }
     }
     ```

   7b. **IF Node — ACTIONABLE?**
   - No → skip to 7d with `Action Taken = logged_only`
   - Yes → 7c

   7c. **Notion Node — Check Duplicate:**
   - Query Tasks by `Source ID = {{item.sourceId}}`
   - If exists and status != done → update existing (Update Log entry)
   - If not exists → Notion Node: Create Task in Tasks DB with all fields from classifier output

   7d. **Google Sheets Node — Update Processing Log row:**
   - Match by Source ID
   - Set: `Triage Status = classified`, `Classification`, `Classification Reason`, `Task ID`, `Action Taken`, `Processed At`

   7e. **Update Run Session counter** (every 3 items — checkpoint)

8. **Final: Update Run Session:** status=completed, counts, summary

### Cache Strategy
- Classification system prompt (~2500 tokens) uses `cache_control: {type: "ephemeral"}`
- In a batch of 5 items within 5 minutes, cache stays warm; savings ~90% on system prompt reads
- First item writes cache (cost: 1.25x), next 4 read cache (cost: 0.1x)

### Critical Differences from Old PART3
1. **Single fetch of pending items** — Sheets filter replaces multiple MCP semantic searches
2. **No schema fetches** — Notion schema is embedded in node configuration
3. **No multiple writing-style searches** — loaded once via Rules & Memory read
4. **Item-level error handling** — failure on one doesn't stop batch
5. **Automatic checkpoints** — every item update is a checkpoint

---

## 7. Workflow 4: Action Executor

**Purpose:** Execute AI actions on tasks with `Action Status = pending`.

**Schedule:** `*/30 14-22 * * *` (every 30 min, 10:00-18:00 NYC)

### Nodes:

1. **Schedule Trigger**
2. **Create Run Session** (Run Type=EXECUTOR)
3. **Notion Node — Query Tasks:**
   - Filter: `Action Status = pending`
   - Max: 10
4. **Notion Node — Read Rules & Memory** (for writing_style profiles)
5. **Split In Batches:** size 3
6. **Switch Node:** route by `Requested Action`
   - Route 1: draft_reply_he / draft_reply_en → Drafting subflow
   - Route 2: draft_whatsapp_he / draft_whatsapp_en → WhatsApp drafting
   - Route 3: summarize_history → Summary subflow
   - Route 4: find_in_emails → Search subflow
   - Route 5: check_past_handling → Pattern matching subflow
   - Route 6: schedule_meeting → Calendar creation
   - Route 7: set_reminder → Calendar creation with reminder
   - Route 8: financial_advisor → **Opus** model, complex analysis
   - Route 9: call_preparation → **Opus** if legal tag, else Sonnet
   - Route 10: draft_settlement_request → Sonnet
   - Route 11: open_payment_page → just construct URL, no AI
   - Route 12: custom → use Custom Action field as prompt

7. **Each route ends:**
   - Update Task: `Action Status = completed`, `Action Result = <output>`, `Action Completed At = now`
   - Append to Action History sheet
8. **On error:**
   - Update Task: `Action Status = failed`, `Action Error = <error>`, `Action Retry Count += 1`
   - If retry count >= 3 → `Action Status = failed_permanently`

---

## 8. Workflow 5: Error Handler

Dedicated error workflow that receives failures from other workflows.

- Trigger: Error Trigger (n8n native)
- Action: Append to Action History sheet with details
- Send email alert to chanoch@maor.org if 3+ errors in 1 hour

---

## 9. Testing & Rollout Plan

### Week 1: Collector
- **Day 1:** Build Workflow 1, manually execute with a single email as test
- **Day 2:** Enable schedule, monitor Run Sessions sheet for one day
- **Day 3:** If stable, disable old Claude Code PART1

### Week 1: Classifier
- **Day 4:** Build Workflow 3, test with 1-2 pending items from Sheet
- **Day 5:** Enable schedule alongside old PART3 (redundant but safe)
- **Day 6:** If stable, disable old PART3

### Week 2: WhatsApp + Executor + Error Handler

### Testing checklist per workflow
- [ ] Manual execution succeeds with single item
- [ ] Pin sample data, step through each node
- [ ] Check Execution History UI — can see each node's I/O
- [ ] Simulate failure in one node, confirm other items continue
- [ ] Confirm Sheet row appears with correct data
- [ ] Confirm Notion task appears (for Workflow 3) with correct fields
- [ ] Scheduled trigger fires at expected time

---

## 10. AI Prompts (Canonical)

### 10.1 Spam Check System Prompt (Haiku, cacheable)

```
You are a spam classifier for Chanoch Chaskind, director of Maor nonprofit.

Classify input as SPAM or NOT_SPAM.

SPAM indicators:
- Marketing newsletters, promotional offers
- Automated notifications with no required action (DigitalOcean tips, hosting promos)
- "Getting started" / onboarding series
- Receipts/invoices are NOT spam (they're informational, still log them)

NOT_SPAM indicators:
- Any financial / legal / government mail
- Personal correspondence
- Anything from: bank, mortgage company, SBA, HRA, OATH, IRS, DOJ, lawyers
- Anything with deadlines or dollar amounts
- Anything from known contacts (family, business associates)
- Anything in Hebrew (treat as not spam by default — personal/community)
- Security/account notifications (password resets, login alerts, account changes)

When uncertain: prefer NOT_SPAM. False negatives (miss important mail) are much worse than false positives (small extra classification work).

Output JSON ONLY:
{"is_spam": true/false, "reason": "brief explanation"}
```

### 10.2 WhatsApp Conversation Classifier (Sonnet, cacheable)

```
You analyze WhatsApp conversations for Chanoch Chaskind.

Classify each conversation (not individual messages) into ONE category:
- NEEDS_RESPONSE: user owes a reply to someone
- WAITING_REPLY: user sent last message, awaiting response
- PERSONAL_REMINDER: self-notes, todos, ideas user sent themselves
- CLOSED: conversation concluded, no action needed
- NOISE: reactions, acknowledgments only, no substance

Context about user:
- Runs Maor (Rebbe video content for children)
- Family: wife Bassie, 8 children
- Language: Hebrew primary, English secondary, some Yiddish
- Secretary Chava: +17326660770

For NEEDS_RESPONSE and PERSONAL_REMINDER, also assess urgency:
- urgent: deadline today/tomorrow, payment blocked, emergency
- high: deadline this week, important decisions
- medium: deadline this month
- low: no deadline

Output JSON ONLY:
{
  "classification": "NEEDS_RESPONSE|WAITING_REPLY|PERSONAL_REMINDER|CLOSED|NOISE",
  "summary_he": "2-3 sentences in Hebrew summarizing what the conversation is about",
  "urgency": "urgent|high|medium|low"
}
```

### 10.3 Deep Classifier System Prompt (Sonnet, cacheable, ~2500 tokens)

```
You are the deep task classifier for Chanoch Chaskind, director of Maor nonprofit.

CONTEXT:
- User address: 675 Rutland Rd, Brooklyn NY 11203
- Phone: 929-221-0408
- Email: chanoch@maor.org
- Family: Bassie (wife), Sholom, Shula B., Mussia, Shifra E., Yehudis, Sheina, Chana, Mendel M.
- Organization: Maor (nonprofit producing Rebbe video content for children); 501(c)(3)
- Secretary: Chava, phone +17326660770
- Known active matters:
  * Citizens Bank mortgage, account 8000127061, hardship application in review
  * SBA loan 6432518209, past due
  * NYC HRA Case 003914182F (Public Assistance, SNAP, Medicaid for family of 10)
  * UNIFIN/Jefferson Capital BEST EGG debt
  * 2 OATH sanitation summonses
  * Discover merchant class action (3 claim forms, deadline May 18)

TASK: Classify each item as ACTIONABLE or INFORMATIONAL.
- ACTIONABLE: requires user decision, response, or action. Creates a Task.
- INFORMATIONAL: useful to log but no action needed (receipts, confirmations, newsletters, community bulletins).

For ACTIONABLE items, populate a full task object with:

PRIORITY:
- urgent: deadline within 48 hours, overdue payments, legal threats, payment blocking access
- high: deadline this week, settlement offers, financial decisions, foreclosure warnings
- medium: deadline this month, routine correspondence requiring response
- low: no explicit deadline, general follow-ups

DUE_DATE:
- Extract from content if stated ("reply by...", "deadline is...", "due on...")
- If not stated, infer from priority (urgent→2 days, high→7 days, medium→14 days, low→null)
- Format: YYYY-MM-DD

DESCRIPTION_HE:
- RICH PROSE in Hebrew
- MUST include: dollar amounts, account numbers, deadlines, contact phone/email, consequences of inaction
- Structured with sections if helpful: background, options, deadlines, contacts
- Never just "Email from X" — always substantive

CATEGORY:
- maor: Maor nonprofit business (501(c)(3), EIN XX-XXX0422, PMB 106 478 Albany Ave)
- personal: family, household, personal finance (675 Rutland)

TAGS (multi-select from): payments, legal, family, tech, mortgage, maor

SUGGESTED_ACTIONS (pick 2-3 from catalog):
- Communication: draft_reply_he, draft_reply_en, draft_whatsapp_he, draft_whatsapp_en, send_email, send_whatsapp
- Research: summarize_history, find_in_emails, check_past_handling, find_contact_details
- Management: schedule_meeting, set_reminder, forward_to_chava, create_drive_folder
- Financial: financial_advisor, call_preparation, draft_settlement_request, open_payment_page
- Meta: custom (when none fits — user writes in Custom Action field)

CONTACT_PERSON: Extract name + phone + email from content when present.

LINKED_PROJECT: Match to existing projects only if clearly connected (e.g., Citizens Bank Mortgage, HRA Benefits). Use exact project name, otherwise null.

OUTPUT JSON ONLY, no commentary:

{
  "classification": "ACTIONABLE" | "INFORMATIONAL",
  "reason_he": "1 sentence why classified this way",
  "task": { /* only if ACTIONABLE, else omit */
    "title_he": "...",
    "priority": "urgent|high|medium|low",
    "due_date": "YYYY-MM-DD or null",
    "description_he": "...",
    "contact_person": "...",
    "category": "maor|personal",
    "tags": ["..."],
    "suggested_actions": ["..."],
    "linked_project": "... or null"
  }
}
```

### 10.4 Drafting Prompts (Sonnet, per action)

#### draft_reply_he
```
[SYSTEM, cacheable]
Draft an email reply in Hebrew in Chanoch's voice.

WRITING STYLE (from writing_style_he in Rules & Memory):
[Insert current writing_style_he content here at build time]

Key traits:
- Greeting: "שלום וברכה" (formal) or "היי" (informal)
- Closing: "משיח נאו!" (always)
- Medium-low formality, direct, warm

Output ONLY the email body (subject + body separated by "---"). No commentary.

[USER]
Task: {task.title_he}
Description: {task.description_he}
Reply-to Context: {task.reply_to_context}
Intent: {draft a reply that: [derive from description]}
```

#### draft_reply_en
Same structure, use writing_style_en. Closing: "Thank you".

#### draft_whatsapp_he / _en
Short, conversational, no formal structure. Max 3 short messages.

#### summarize_history
```
[SYSTEM, cacheable]
You summarize email/message history about a topic. Output structured summary in Hebrew:
1. Background (2-3 sentences)
2. Timeline (chronological bullet points)
3. Current status
4. Open questions
5. Suggested next step

[USER]
{collection of related emails/messages}
```

#### financial_advisor (USE OPUS)
```
[SYSTEM, cacheable]
You are a financial advisor for Chanoch Chaskind, analyzing debt/payment situations.

CONTEXT: [user's known financial situation]

Your analysis must include:
1. Options available (list all with pros/cons)
2. Recommended option with reasoning
3. Cash flow impact (monthly/lump)
4. Risks of each option
5. Specific next steps

Output in Hebrew with clear sections.

[USER]
{task description, deadlines, amounts}
```

#### call_preparation
```
[SYSTEM]
Prepare a call script/brief for the user.

Output:
1. Call purpose (1 sentence)
2. Facts to have ready (account numbers, dates)
3. Questions to ask
4. Outcomes to push for
5. Fallback position if they resist

Output in Hebrew.
```

---

## 11. Credentials & API Keys Setup Procedure

For each credential, use this procedure in n8n:

1. Credentials → + Add Credential → select type
2. For OAuth: click "Sign in with Google/Notion" → complete flow in popup
3. For API keys: paste value
4. Name using convention from §1.2
5. Save

After all credentials set, test each in a minimal workflow:
- Gmail: "Get last message" should return one
- Drive: "List files in folder" should return files
- Sheets: Create a test tab, write a row, read it
- Notion: Fetch one known page
- Anthropic: Send "hello" to Haiku, expect response

---

## 12. Rollout — What to Build in What Order

### Phase 0: Setup (Day 1)
1. Verify n8n MCP is working
2. Verify all credentials (§11)
3. Create Google Sheet "Task Manager Audit" (§3)
4. Record Sheet ID in a note

### Phase 1: Audit Logging (Day 2)
1. Build Workflow 1 (Collector)
2. Test manually with small data
3. Run once, verify Sheet populates correctly

### Phase 2: Classification (Day 3)
1. Build Workflow 3 (Classifier)
2. Test with 1-2 pending items already in Sheet
3. Verify Task creation in Notion

### Phase 3: Enable schedules (Day 4)
1. Enable Workflow 1 schedule
2. Enable Workflow 3 schedule
3. Monitor Run Sessions for 24 hours

### Phase 4: WhatsApp (Day 5)
1. Build Workflow 2
2. Test, enable

### Phase 5: Executor (Day 6)
1. Build Workflow 4
2. Test each action route individually
3. Enable

### Phase 6: Error Handler (Day 7)
1. Build Workflow 5
2. Wire error triggers from all other workflows
3. Test by triggering a failure

### Phase 7: Decommission old system
1. Disable Claude Code routines (PART1, PART2, PART3, PART4)
2. Keep CLAUDE.md as reference only
3. Old Notion Processing Log: leave as historical record, don't delete

---

## 13. Monitoring & Debugging (for User)

Document this for user in Hebrew (separate from this brief):

- **Execution History** — n8n's main monitoring view
- **Pin Data** — capture real run outputs for testing
- **Retry from failed node** — fix and resume without full rerun
- **Sheet-based audit trail** — user can filter Processing Log directly
- **Error email alerts** — via Workflow 5

---

## 14. Known Issues & FAQ

### Q: What if n8n can't filter Notion by property?
A: Notion's native Filter Database in n8n supports property filters. If a specific version doesn't, use HTTP Request node with Notion API directly (`POST /v1/databases/{id}/query` with filter body).

### Q: Prompt caching not working?
A: Cache requires minimum 1024 tokens (Sonnet/Opus) or 2048 (Haiku). If system prompt is smaller, padding won't help — just accept normal pricing.

### Q: Rate limits on Anthropic API?
A: Default is 50 req/min. Workflow 3 with batches of 5 processing ~15 items takes 3 batches with 5-sec gaps = well within limits.

### Q: What if Sheet row limit is hit?
A: Google Sheets supports 10M cells. With 20 columns in Processing Log, that's 500K rows. Plenty of headroom. If nearing limit, archive old rows to second Sheet.

### Q: How to handle Hebrew in Sheets?
A: UTF-8 native. No special handling needed. Can use `=FILTER()` and sort in Hebrew just fine.

### Q: Drive permission issues?
A: Ensure n8n credential scope includes Drive read access, and the ScanSnap folder is accessible to the OAuth user.

---

## 15. Completion Criteria

You (Claude Code) are done when:
- [ ] All 5 workflows exist in n8n
- [ ] All workflows pass manual test with real data
- [ ] All schedules are enabled
- [ ] Google Sheet audit log is being populated
- [ ] First real classification run created at least 1 Task successfully
- [ ] User can view Execution History and see results
- [ ] Error Workflow triggers on a simulated failure
- [ ] User has received a brief demo/walkthrough

---

## 16. What NOT to Do

- ❌ Don't recreate existing Notion databases (use IDs in §1.3)
- ❌ Don't delete the old Notion Processing Log DB
- ❌ Don't touch the Netlify app (it keeps reading Notion Tasks)
- ❌ Don't modify existing Tasks in Notion (migrate-in-place, not recreate)
- ❌ Don't use Batch API (too slow for deadlines)
- ❌ Don't truncate Raw Content (financial details often mid-document)
- ❌ Don't auto-add hard rules from AI suggestions (user must approve)
- ❌ Don't use Opus for routine tasks (too expensive)
- ❌ Don't skip checkpoints in Workflow 3 (updates must be real-time)

---

## 17. Communication with User

- Respond in Hebrew when explaining to user
- Use HTML artifacts with `dir="rtl"` and Noto Sans Hebrew font for any multi-paragraph explanation (user has confirmed this is the only way Hebrew reads correctly for them)
- Ask for clarification once per ambiguity — don't re-ask the same question
- Before enabling any schedule, confirm with user ("Enable Collector schedule now?")
- After each phase, give a short Hebrew status update

---

**END OF BRIEF**

This document is complete. If anything is unclear, ask user before guessing.
