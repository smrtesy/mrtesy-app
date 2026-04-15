# QA Verification Prompts

Two prompts: Quick QA (after each change) and Full Audit (after a feature/milestone).

---

## Prompt A: Quick QA (after each code change)

```
Run a QA check on the changes just made:

1. Run `tsc --noEmit`. Fix all errors before proceeding.

2. Start Preview server. Authenticate via `/api/dev-login` (fetch tokens → set cookie → reload). If dev-login unavailable, navigate directly with dev bypass.

3. For each page affected by the change:
   a. Navigate and screenshot
   b. Check console errors (preview_console_logs level=error)
   c. Check failed network requests (preview_network filter=failed)
   d. Click any changed interactive elements, screenshot the result

4. Check 1-2 adjacent pages that share components/data with the changed page. Screenshot + console only.

5. Report per change: BEFORE → AFTER, console errors, network errors.

Rules:
- Don't report issues in files you didn't modify
- Don't say "missing" for conditionally rendered content (empty data ≠ missing feature) — say "UNVERIFIED" if you can't test with real data
- Don't say "missing" for external services — first check if deployed on Supabase/Vercel (use list_edge_functions, get_logs)
- Read the actual source code before claiming something doesn't exist
```

---

## Prompt B: Full Audit (after milestone / new feature set / before release)

```
Run a full project audit. Follow ALL steps:

### STEP 1: Architecture Doc vs Code
Read the architecture doc (doc-text.txt or the original .docx).
Go section by section and check:
- Every page/route listed in the doc — does it exist?
- Every component listed — does it exist and match the spec?
- Every DB table and field — is it in the types and used in code?
- Every feature described — is it implemented? 
For each item: EXISTS / PARTIAL / MISSING / NOT IN DOC (extra)

### STEP 2: External Services Check
Use Supabase MCP tools:
- list_edge_functions → verify all expected functions are deployed and ACTIVE
- get_logs service=edge-function → check for errors in last 24h
- execute_sql → check table structure matches expected schema
- list_migrations → verify migration history
Don't assume something is missing just because it's not in the local repo.

### STEP 3: Translation Completeness
Read both translation files (he.json, en.json):
- Every key in one must exist in the other
- Search components for hardcoded strings that should use t()
- Check that priority, status, and filter labels use translations

### STEP 4: Visual Page-by-Page Scan
Start Preview, authenticate, then for EVERY page:
- Navigate → screenshot → console errors → network errors
- Check RTL layout is correct
- Check all tabs/filters work
- Click at least one interactive element per page
Pages: tasks, suggestions, log, calendar, projects, settings, admin, admin/users, admin/services, admin/logs, login, onboarding (if accessible)

### STEP 5: Interaction Testing
Test these flows end-to-end:
- Inbox → click task → detail opens → verify all sections
- Click AI action button → verify it calls Edge Function → result appears
- Switch tab (Inbox/Active/Completed) → verify correct filtering
- Suggestions → approve/dismiss → verify action works
- FAB (+) → Smart Task Input → type text → verify AI parsing
- Settings → verify connection status matches reality

### STEP 6: Report
Organize findings by severity:
- CRITICAL: blocks user flow
- BUG: works wrong
- MISSING: feature in doc but not built
- TRANSLATION: language issue
- UX: design/usability issue
- UNVERIFIED: couldn't test (explain why)

For each finding include: page, description, file path, suggested fix.

Rules:
- Conditionally rendered content with no data = UNVERIFIED, not MISSING
- External services not in repo = check Supabase first, not MISSING
- Don't invent issues — only report what you actually see broken
- Every "MISSING" claim must link to the doc section AND prove the code doesn't exist
```

---

## When to use which

| Situation | Prompt |
|-----------|--------|
| Fixed a bug | A (Quick QA) |
| Changed one component | A |
| Added translations | A |
| Completed a feature | B (Full Audit) |
| Before deploying to production | B |
| Starting work on existing project | B |
| After long break from project | B |
