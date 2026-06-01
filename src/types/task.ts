export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  created_at: string;
  completed_at: string | null;
  created_by: "user" | "ai";
}

export type TaskMaterialType = "note" | "link" | "file" | "contact";

export interface TaskMaterial {
  id: string;
  type: TaskMaterialType;
  title: string;
  content?: string;
  url?: string;
  file_path?: string;
  file_size?: number;
  file_mime?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  created_at: string;
  created_by: string;
}

export interface Task {
  id: string;
  title: string;
  title_he: string | null;
  description: string | null;
  priority: "urgent" | "high" | "medium" | "low";
  status: "inbox" | "in_progress" | "snoozed" | "archived" | "completed" | "pending_completion";
  has_unread_update?: boolean | null;
  completion_signal_detected?: boolean | null;
  completion_signal_reason?: string | null;
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
  checklist: ChecklistItem[];
  task_materials: TaskMaterial[];
  related_contact: string | null;
  related_contact_email: string | null;
  related_contact_phone: string | null;
  ai_confidence: number | null;
  ai_model_used: string | null;
  manually_verified: boolean;
  today_position: number | null;
  seen_at: string | null;
  last_interaction_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  assigned_to_user_id: string | null;
  /** Embedded via Supabase left-join: projects(id, name, name_he, color, parent_id) */
  projects?: { id: string; name: string; name_he: string | null; color: string | null; parent_id: string | null } | null;
  source_message_id: string | null;
  /** Embedded via Supabase left-join: source_messages(id, source_type, source_url, serial_display) */
  source_messages?: { id?: string | null; source_type: string | null; source_url: string | null; serial_display: string | null } | null;
  task_type: "action" | "project_suggestion" | "brief_review" | "followup";
  /** Human-readable serial: T1, T2, ... — assigned by DB trigger */
  serial_display: string;
}
