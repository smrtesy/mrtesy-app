"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Save, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// Default prompts (server defaults — can be overridden per user in DB)
const DEFAULT_PROMPTS: Record<string, { label: string; description: string; default: string }> = {
  whatsapp_classifier: {
    label: "WhatsApp Classifier",
    description: "System prompt used to classify WhatsApp conversation threads (PART 2)",
    default: `You analyze WhatsApp conversations for Chanoch Chaskind, director of the Maor nonprofit organization.
Given the last messages in a conversation thread, classify the conversation status and suggest actions.

Output ONLY valid JSON (no markdown fences):
{
  "status": "NEEDS_RESPONSE|WAITING_REPLY|PERSONAL_REMINDER|CLOSED|NOISE",
  "topic": "short Hebrew description of topic",
  "urgency": "urgent|high|medium|low",
  "last_msg_summary": "brief summary of the last message in Hebrew",
  "suggested_actions": ["action1", "action2"],
  "ideal_response_time": "morning|afternoon|evening|none",
  "context_summary": "2-3 sentence Hebrew summary of conversation"
}

NEEDS_RESPONSE: last message is incoming, contains a question or request, more than 4 hours old
WAITING_REPLY: last message is outgoing and was a question, no reply in more than 24 hours
PERSONAL_REMINDER: message contains a reminder or task for Chanoch to act on
CLOSED: conversation ended with acknowledgment (ok, thanks, received, reaction)
NOISE: automated/bot messages with no dialog`,
  },
  deep_classifier: {
    label: "Deep Classifier",
    description: "System prompt used to classify emails/documents into tasks (PART 3)",
    default: `You are the task classifier and builder for Chanoch Chaskind, director of Maor nonprofit organization.

Classify each message as ACTIONABLE or INFORMATIONAL, then build a task for ACTIONABLE items.

ACTIONABLE = requires a real action or decision from Chanoch.
INFORMATIONAL = useful to know but no action needed right now.

Output ONLY valid JSON (no markdown fences).

For ACTIONABLE:
{
  "classification": "ACTIONABLE",
  "confidence": 0.0-1.0,
  "reason_he": "short reason in Hebrew",
  "task": {
    "title_he": "clear specific action title in Hebrew",
    "priority": "urgent|high|medium|low",
    "due_date": "YYYY-MM-DD or null",
    "description_he": "Full context with numbers, dates, contacts, stakes",
    "contact_person": "name + phone + email if mentioned",
    "category": "maor|personal",
    "tags": ["payments","legal","family","tech","mortgage","maor"],
    "suggested_actions": ["action1","action2","action3"]
  }
}

For INFORMATIONAL:
{
  "classification": "INFORMATIONAL",
  "confidence": 0.0-1.0,
  "reason_he": "short reason in Hebrew"
}`,
  },
};

interface Prompt {
  id: string;
  prompt_key: string;
  content: string;
  version: number;
  updated_at: string;
}

export default function AdminPromptsPage() {
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
      <div>
        <h1 className="text-2xl font-bold">AI Prompts</h1>
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
