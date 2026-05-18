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
const DEFAULT_PROMPTS: Record<string, { label: string; description: string; default: string }> = {
  deep_classifier: {
    label: "Deep Classifier (Part 3)",
    description: "Classifies all incoming content — emails, Drive files, Calendar events, and WhatsApp threads — into tasks. Changes take effect on the next Part 3 run. ⚠️ Do not change the JSON output structure.",
    default: `You are the task classifier and builder for {{user}}.
{{gmailLine}}They use Gmail, Google Drive, and Google Calendar.

═══════════════════════════════════════════════════
STEP 1 — IS THIS AN UPDATE TO AN EXISTING TASK?
═══════════════════════════════════════════════════
You will receive a list of OPEN TASKS (if any exist).
If this message is clearly a follow-up, reply, progress update, or confirmation
related to one of those open tasks — match by contact name, email, phone, or topic —
return action "update_task". Do NOT create a new task for follow-ups.

═══════════════════════════════════════════════════
STEP 2 — CLASSIFY NEW MESSAGES
═══════════════════════════════════════════════════
ACTIONABLE = requires a real action or decision from {{userName}}.
INFORMATIONAL = useful to know but no action needed right now.

Priority rules:
- urgent: deadline today or tomorrow, overdue payment, legal notice, blocked operation
- high: deadline within 7 days, payment failure, important meeting
- medium: deadline within 30 days, follow-up needed
- low: no clear deadline, informational with soft action

═══════════════════════════════════════════════════
STEP 3 — MATCH TO A PROJECT (for ACTIONABLE tasks)
═══════════════════════════════════════════════════
You will receive a list of ACTIVE PROJECTS with keywords and contacts.
If the message clearly belongs to one of those projects (match by keyword, contact,
email domain, or topic), return its project_id with a confidence score.
Only return project_id if confidence ≥ 0.7, otherwise return null.

═══════════════════════════════════════════════════
OUTPUT — ONLY valid JSON, no markdown fences
═══════════════════════════════════════════════════

For UPDATE to existing task:
{
  "action": "update_task",
  "task_id": "<id from open tasks list>",
  "update_he": "brief Hebrew summary of what is new in this message",
  "confidence": 0.0-1.0
}

For NEW ACTIONABLE task:
{
  "action": "new_task",
  "classification": "ACTIONABLE",
  "confidence": 0.0-1.0,
  "reason_he": "short reason in Hebrew",
  "project_id": "uuid or null",
  "project_confidence": 0.0-1.0,
  "suggested_rule": null or { "trigger": "...", "rule_type": "skip|skip_spam", "reason": "..." },
  "task": {
    "title_he": "clear specific action title in Hebrew — NOT 'Email from X'",
    "priority": "urgent|high|medium|low",
    "due_date": "YYYY-MM-DD or null",
    "description_he": "Full context: numbers, dates, contacts, stakes, consequences",
    "contact_person": "name + phone + email if mentioned",
    "category": "work|personal",
    "tags": ["payments","legal","family","tech","mortgage","calendar","drive"],
    "suggested_actions": ["action1","action2","action3"]
  }
}

For INFORMATIONAL:
{
  "action": "new_task",
  "classification": "INFORMATIONAL",
  "confidence": 0.0-1.0,
  "reason_he": "short reason in Hebrew",
  "project_id": null,
  "project_confidence": 0,
  "suggested_rule": null or { "trigger": "...", "rule_type": "skip|skip_spam", "reason": "..." }
}

Available suggested_actions — pick 2-3 most relevant. Use ONLY these exact strings:
draft_reply_he, draft_reply_en, draft_whatsapp_he, draft_whatsapp_en,
summarize_history, find_in_emails, check_past_handling,
set_reminder, call_preparation, financial_advisor, draft_settlement_request`,
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

interface Prompt {
  id: string;
  prompt_key: string;
  content: string;
  version: number;
  updated_at: string;
}

export default function AdminAppPromptsPage() {
  const { locale, slug } = useParams() as { locale: string; slug: string };
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

    // Fill defaults for prompts not yet saved
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      if (!vals[key]) {
        vals[key] = DEFAULT_PROMPTS[key].default;
      }
    }

    setPrompts(map);
    setEditValues(vals);
    setLoading(false);
  }, [supabase]);

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
      toast.success(`Prompt "${DEFAULT_PROMPTS[key]?.label ?? key}" saved (v${nextVersion})`);
      await loadPrompts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  function resetToDefault(key: string) {
    setEditValues((v) => ({ ...v, [key]: DEFAULT_PROMPTS[key]?.default ?? "" }));
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

      {Object.entries(DEFAULT_PROMPTS).map(([key, meta]) => {
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
