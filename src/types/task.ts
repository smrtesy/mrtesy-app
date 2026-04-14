export interface Task {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
  priority: "urgent" | "high" | "medium" | "low";
  status: "inbox" | "in_progress" | "snoozed" | "archived" | "completed";
  due_date: string | null;
  due_time: string | null;
  reminder_at: string | null;
  recurrence_rule: string | null;
  snoozed_until: string | null;
  snooze_count: number;
  tags: string[] | null;
  ai_actions: Array<{ label: string; prompt: string }>;
  ai_generated_content: Array<{
    id: string;
    created_at: string;
    action_label: string;
    result?: string;
    draft_url?: string;
    prompt?: string;
    model?: string;
    cost_usd?: number;
  }>;
  updates: Array<{
    id: string;
    created_at: string;
    type: string;
    actor: string;
    content: string;
  }>;
  linked_drive_docs: Array<{
    name: string;
    url: string;
  }>;
  related_contact: string | null;
  related_contact_email: string | null;
  related_contact_phone: string | null;
  ai_confidence: number | null;
  ai_model_used: string | null;
  manually_verified: boolean;
  seen_at: string | null;
  last_interaction_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  source_message_id: string | null;
  task_type: "action" | "project_suggestion" | "brief_review" | "followup";
}
