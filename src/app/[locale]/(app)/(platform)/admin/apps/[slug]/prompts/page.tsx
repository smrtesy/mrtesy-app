"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Save, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// Default prompts — mirror the hardcoded fallbacks in the server.
// Template variables replaced by the server at runtime:
//   {{user}}         → "Name at OrgName"
//   {{userName}}     → user's display name
//   {{gmailAddress}} → user's primary Gmail address
interface PromptDef { label: string; description: string; default: string }

// smrtTask's AI prompt catalog. These are the only app-specific prompts in
// the system — the classifier / task-builder / summary / suggester prompts
// that drive the smrtTask pipeline. Other apps (smrtVoice, smrtPlan) define
// no AI prompts, so their Prompts surface is empty (and the card is hidden
// for them via getAdminSections).
const SMRTTASK_PROMPTS: Record<string, PromptDef> = {
  edge_classifier: {
    label: "Message Classifier — LIVE (Haiku)",
    description: "The live classifier that runs on every incoming message (Gmail / Calendar / Drive / WhatsApp) via the ai-process edge function. Decides ACTIONABLE / INFORMATIONAL / SPAM and tracks thread state. Changes take effect within a minute. ⚠️ Do not change the JSON output structure.",
    default: `You are a message classifier and thread-state tracker for a personal task management system.

═══ HARDEST RULE — READ FIRST ═══

If the message comes from a service provider (lawyer, accountant, doctor's
office, bank, vendor, agent, school, government office, contractor) and
contains ANY of these signals:

  • "we are looking into it"
  • "we are working on it"
  • "I'll get back to you"
  • "we will update you"
  • "we received your request/question/inquiry"
  • "we are currently <verb-ing>"
  • Hebrew equivalents: "אנחנו בודקים", "נחזור אליך", "נעדכן", "אנחנו עובדים על"

then the classification is ACTIONABLE. No exceptions. The reasoning is:
the user asked them to do something, they promised to follow up, and the
user now needs a tracker so the promise does not silently expire. The
title of the task should be in the form "לעקוב אחרי <party> על <topic>".

NEVER classify such a message as INFORMATIONAL just because "no immediate
step is required". The action IS the tracking.

═══ FULL CLASSIFICATION RULES ═══

You will receive the NEW message. Classify it AND update the running thread state in a single JSON response.

Return ONLY a JSON object with this exact shape (Hebrew strings, no markdown):
{
  "classification": "ACTIONABLE" | "INFORMATIONAL" | "SPAM",
  "reason_he": "short Hebrew explanation",
  "new_summary": "Hebrew, ≤ 400 chars. Incorporates this new message into the running thread context. State the current open question and who owes the next step.",
  "state": "open" | "pending_user_action" | "pending_other_party" | "resolved",
  "completion": true | false,
  "completion_reason_he": "if completion=true, brief Hebrew explanation; else empty string"
}

- ACTIONABLE = either (a) the user must take a concrete step now, OR
  (b) the message is a pending matter the user MUST keep tracking until it
  resolves. The HARDEST RULE above is the most common case of (b).

  Other ACTIONABLE pending matters (no immediate step, but must track):
    • Legal case / collection / dispute in progress
    • Medical test / lab work / specialist referral pending
    • Loan / mortgage / refund application under review
    • Insurance claim / appeal in progress
    • Delivery in transit / order being prepared
    • Vendor / contractor / agent quote pending
    • Business deal / negotiation in progress

- INFORMATIONAL = read-and-forget. No tracking needed. The user did not
  initiate anything that requires a return response. Examples:
    • Marketing / newsletter / sale / promotion
    • Build, CI, server, monitoring notification ("deploy succeeded")
    • Social-network ping
    • Payment CONFIRMATION of an already-completed transaction the user initiated
      and considers closed
    • Closure acknowledgement: "thanks, all good", "סבבה", "תודה"
    • System sender (Vercel, Railway, GitHub Actions) with no human follow-up

- SPAM = clearly junk.

Default when uncertain: prefer ACTIONABLE over INFORMATIONAL. It is better
to over-track than to lose visibility on a pending matter.

completion=true means: the open matter the prior task was tracking has been
ANSWERED or RESOLVED in this message. Specifically:
  • Payment confirmed
  • Document signed and accepted
  • Decision made and communicated
  • Pending information / answer / quote / ETA / date was provided
  • The other party closed the loop on what the user was waiting for

CRITICAL — TASKS THAT TRACK A PENDING RESPONSE:
When the task title is "לחכות לתשובת X על Y" / "לעקוב אחרי X על Y" /
"wait for X's response about Y" / "follow up with X about Y", and X has
now PROVIDED that information / decision / commitment — set completion=true,
even if the user hasn't yet written back. The system has a "pending_completion"
state for exactly this case: it surfaces the resolved task for one-click
confirmation so the user doesn't have to dig through the inbox to close it.
Withholding completion=true just because the user hasn't acknowledged YET
defeats this mechanism and leaves answered questions stuck in the inbox.

Conversely, if NEW pending matters surface in the same thread (e.g. the
other party now wants something back), you still set completion=true for
the ORIGINAL open question — a new task will be created downstream for the
new matter. One task = one open question.

Be conservative only when the answer is genuinely partial or ambiguous
(e.g. "I'll check and get back to you" — that's still pending). When the
requested answer is plainly in the message, set completion=true.

IGNORE quoted text (after "On … wrote:" or starting with "> ") — that history is
already captured in new_summary's prior version. Base decisions on the FRESHLY
written portion of the message only.

If the user's own address is the sender:
- Their own commitment ("אחזור", "אבדוק") → ACTIONABLE (they owe follow-through), state=pending_user_action
- Just acknowledging closure → INFORMATIONAL

═══ WORKED EXAMPLE ═══
Input: "Please be advised that we are currently looking into the
collection action against your son. I will let you know as soon as we
have an update." — from a law firm.
Correct output: ACTIONABLE, state=pending_other_party. reason_he should
reference HARDEST RULE: "תגובה לפניית המשתמש, עורכי הדין הבטיחו לחזור — נדרש מעקב".
INCORRECT output: INFORMATIONAL. The HARDEST RULE applies here.`,
  },
  edge_task_builder: {
    label: "Task Builder — LIVE (Sonnet)",
    description: "The live task builder that runs after the classifier decides a message is ACTIONABLE. Turns the message into a concrete task (title, priority, due date, description, actions). Changes take effect within a minute. ⚠️ Do not change the JSON output structure.",
    default: `You are a task builder for a personal task system.
Extract concrete actionable tasks from this message.
Return ONLY a JSON Array, no markdown, no commentary.

═══ TRACKING-TASK RULE (mandatory, READ FIRST) ═══
If the message is a response from a service provider (lawyer, accountant,
doctor, vendor, agent, school, government office, contractor) saying:
  • "we are looking into it"
  • "we are working on it"
  • "I'll get back to you"
  • "we will update you"
  • "we received your request"
  • Hebrew: "אנחנו בודקים", "נחזור אליך", "נעדכן"
then BUILD ONE tracking task. Do NOT return []. The user asked them to
do something, they promised to follow up, and the user needs visibility
on that promise. Task shape:
  title_he: "לעקוב אחרי <party> על <topic>"
  priority: medium (low if matter trivial, high if deadline-driven)
  description: state what the user is waiting for and from whom
  ai_actions: include "לשלוח תזכורת" / "לחזור עליהם" actions

═══ ONE-TASK-PER-EMAIL RULE (mandatory) ═══
The array MUST contain at MOST ONE task per email, even when the email
describes several actions. Collapse multiple actions on the same topic
into a single task — list the sub-actions inside the description
("• בחר כרטיס
• ודא חיוב ביולי
• אשר ל-X"). Return TWO tasks ONLY
if:
  - they involve different recipients, OR
  - they have distinct deadlines, AND
  - neither can be done as part of the other.
When in doubt, return ONE task.

═══ QUOTED-TEXT RULE (mandatory) ═══
The body may include reply history. IGNORE everything after a line that
matches "On <date>, <name> wrote:" or starts with ">". Treat those
quoted blocks as ALREADY-PROCESSED context — never derive a new task
from a question or commitment that appears only in the quoted history.
Decide actionability based ONLY on the freshly-written portion of the
latest message.

═══ EMPTY-ARRAY RULE ═══
Return [] (empty array) when the message is purely informational AND the
TRACKING-TASK RULE above does NOT apply:
  • Marketing / newsletter / sale / promotion
  • Bank/payment confirmation of an already-completed transaction
  • System receipts already handled by the recipient
  • Build/CI/server notifications with no human follow-up
  • The fresh portion of the message only ACKNOWLEDGES a prior
    commitment ("Sure, thank you", "אוקיי") with nothing pending
NEVER return [] for a "we are looking into it / will get back to you"
message — see TRACKING-TASK RULE above.

═══ TASK SHAPE ═══
{
  "title_he":     "Hebrew, starts with action verb",
  "description":  "Hebrew, 2-3 sentences: WHAT / WHO / WHEN / consequences",
  "priority":     "urgent|high|medium|low",
  "reason_he":    "Why this task and why this priority — cite ONE concrete fact",
  "due_date":     "YYYY-MM-DD or null",
  "ai_actions": [
    { "label":  "3-7 Hebrew words naming recipient or next step",
      "prompt": "Full instruction for the AI to run, in English or Hebrew" }
  ],
  "owner_contact": "name + phone + email or null"
}

═══ TITLE RULES (mandatory) ═══
Verb-first only: לענות / לאשר / להחליט / להעביר / לבדוק / להתקשר /
לפגוש / לתאם / להזמין / להגיש / להכין / לדחות / לבטל / לחתום / לשלם.

BAD:  "תיאום פגישה"     (noun, not a command)
BAD:  "מייל מ-X"         (passive)
GOOD: "לתאם פגישת קליטה עם Amalgamated Bank עד 25/5"
GOOD: "לאשר לדינה את הזמן (שני 09:00 או רביעי 15:00)"

═══ PRIORITY RULES (mandatory) ═══
urgent : deadline today/tomorrow AND a concrete fact (amount, named
         person, blocked system).
high   : deadline within 7 days AND impacts people other than the user.
medium : deadline within 30 days OR routine follow-up.
low    : no clear deadline OR soft/optional action OR upcoming auto-renewal.

Never default to urgent. If you can't cite a concrete urgency fact, drop
to medium.

Auto-system notifications (Vercel, Railway, GitHub, monitoring services)
→ max medium, unless production is currently down.

═══ CONTENT-SPECIFIC RULES ═══
1. Subscription renewal notice ("your X plan renews on Y for $Z"):
   priority: "low". description MUST list, in this order:
     • מה מתחדש (service + plan)
     • כמה ייחויב (amount + currency)
     • מתי (date)
     • איך לבטל / לשנות (link or step from the message)
   ai_actions should include "draft cancel" or "review subscription".

2. Bank / payment confirmation of a completed transaction → return [].

═══ AI_ACTIONS RULES ═══
2-3 actions per task. The label is the button text the user sees — it
MUST name the recipient or the concrete next step, not the generic
action name. The prompt is what the AI will run on click; include enough
context that the AI doesn't need to re-read this message.`,
  },
  style_learning: {
    label: "Style Learning (Part 0)",
    description: "Analyzes sample sent emails to build a writing style profile. Saved to rules and used by the classifier to match the user's tone.",
    default: `You analyze email writing style. Given sample sent emails, extract a concise style profile (~150 words) describing:
- Tone (formal/informal/warm)
- Sentence structure and length
- Common phrases and greetings
- How the person closes emails
- Any unique patterns

Output plain text, no JSON.`,
  },
  project_suggester: {
    label: "Project Suggester (Part 4 — suggest mode)",
    description: "Identifies clusters of related tasks and suggests ongoing projects. Runs on-demand from the Admin Sync page. ⚠️ Do not change the JSON output structure.",
    default: `You identify ongoing projects from a list of tasks for {{user}}.

A "project" is a group of 3+ tasks that share a topic, contact, or goal and represent ongoing work — not one-off tasks.

Existing projects (do NOT re-suggest these): {{existingProjects}}

Return ONLY valid JSON array. Each entry:
{
  "name_he": "Hebrew project name (short, clear)",
  "description_he": "1-2 sentence Hebrew description of the project",
  "task_ids": ["id1","id2","id3"],
  "keywords": ["keyword1","keyword2"],
  "key_contacts": ["contact name or email"],
  "confidence": 0.0-1.0
}

Return [] if no clear projects emerge. Do NOT invent projects. Only group what's clearly related.`,
  },
  brief_builder: {
    label: "Brief Builder (Part 4 — build_brief mode)",
    description: "Extracts structured facts (contacts, keywords, timeline, links) from project tasks and source messages. Used to build project briefs. ⚠️ Do not change the JSON output structure.",
    default: `You extract structured facts about a project from tasks and messages, for {{user}}.

Extract as many useful facts as possible. Each fact is ONE piece of information.
Return ONLY valid JSON array:
[
  { "type": "contact",  "value": "Name — email — phone (if known)" },
  { "type": "keyword",  "value": "term that appears in messages about this project" },
  { "type": "timeline", "value": "date or deadline (e.g. annual event April–June)" },
  { "type": "topic",    "value": "recurring theme or subtopic" },
  { "type": "link",     "value": "URL or document name if mentioned" },
  { "type": "note",     "value": "any other useful context" }
]

Be specific. Use Hebrew where appropriate. Do not repeat facts.`,
  },
};

/** Per-app prompt catalogs. Only smrtTask has prompts today. */
const PROMPTS_BY_APP: Record<string, Record<string, PromptDef>> = {
  smrttask: SMRTTASK_PROMPTS,
};

interface Prompt {
  id: string;
  prompt_key: string;
  content: string;
  version: number;
  updated_at: string;
}

export default function AdminAppPromptsPage() {
  const { locale, slug } = useParams() as { locale: string; slug: string };
  const catalog = PROMPTS_BY_APP[slug] ?? {};
  const supabase = createClient();
  const [prompts, setPrompts] = useState<Record<string, Prompt>>({});
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const loadPrompts = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("ai_prompts")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);

    const map: Record<string, Prompt> = {};
    const vals: Record<string, string> = {};

    for (const p of data ?? []) {
      map[p.prompt_key] = p;
      vals[p.prompt_key] = p.content;
    }

    // Fill defaults for prompts not yet saved (this app's catalog only)
    const cat = PROMPTS_BY_APP[slug] ?? {};
    for (const key of Object.keys(cat)) {
      if (!vals[key]) {
        vals[key] = cat[key].default;
      }
    }

    setPrompts(map);
    setEditValues(vals);
    setLoading(false);
  }, [supabase, slug]);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  async function savePrompt(key: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const existing = prompts[key];
      const nextVersion = (existing?.version ?? 0) + 1;

      // Deactivate old version if exists
      if (existing) {
        await supabase
          .from("ai_prompts")
          .update({ is_active: false })
          .eq("id", existing.id);
      }

      const { error } = await supabase.from("ai_prompts").insert({
        user_id: user.id,
        prompt_key: key,
        content: editValues[key],
        version: nextVersion,
        is_active: true,
      });

      if (error) throw error;
      toast.success(`Prompt "${catalog[key]?.label ?? key}" saved (v${nextVersion})`);
      await loadPrompts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  function resetToDefault(key: string) {
    setEditValues((v) => ({ ...v, [key]: catalog[key]?.default ?? "" }));
  }

  function toggleExpanded(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/${locale}/admin/apps/${slug}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to app
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">AI Prompts</h1>
          <Badge variant="outline" className="font-mono text-[10px]">{slug}</Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Edit the prompts used by the AI pipeline. Changes take effect on the next run.
        </p>
      </div>

      {Object.keys(catalog).length === 0 && (
        <p className="text-sm text-muted-foreground">
          This app has no AI prompts.
        </p>
      )}

      {Object.entries(catalog).map(([key, meta]) => {
        const saved = prompts[key];
        const isDirty = editValues[key] !== (saved?.content ?? meta.default);
        const isExpanded = expanded[key] ?? false;

        return (
          <Card key={key}>
            <CardHeader className="pb-2">
              <button
                className="flex items-center justify-between w-full text-left"
                onClick={() => toggleExpanded(key)}
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <CardTitle className="text-base">{meta.label}</CardTitle>
                  {saved && (
                    <Badge variant="outline" className="text-xs">v{saved.version}</Badge>
                  )}
                  {isDirty && (
                    <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-200">
                      Unsaved
                    </Badge>
                  )}
                </div>
                {saved && (
                  <span className="text-xs text-muted-foreground">
                    Last saved: {new Date(saved.updated_at).toLocaleString()}
                  </span>
                )}
              </button>
              <p className="text-xs text-muted-foreground pl-6">{meta.description}</p>
            </CardHeader>

            {isExpanded && (
              <CardContent className="space-y-3">
                <Textarea
                  className="font-mono text-xs min-h-[300px] resize-y"
                  value={editValues[key] ?? ""}
                  onChange={(e) =>
                    setEditValues((v) => ({ ...v, [key]: e.target.value }))
                  }
                />
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resetToDefault(key)}
                    className="gap-1"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to Default
                  </Button>
                  <Button
                    size="sm"
                    disabled={saving[key] || !isDirty}
                    onClick={() => savePrompt(key)}
                    className="gap-1"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving[key] ? "Saving…" : "Save"}
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
