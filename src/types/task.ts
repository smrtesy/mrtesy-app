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
  status: "inbox" | "in_progress" | "snoozed" | "archived" | "completed" | "pending_completion" | "dismissed";
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
  /** Desk model: quick (one bounded action) vs regular (needs prep / multi-step). */
  size?: "quick" | "regular";
  /** Execution context — where this can be done. Null = unspecified (work implied). */
  context?: "home" | "work" | null;
  /** Set when the row wakes from snooze; cleared on first interaction (drives the chip). */
  woke_from_snooze_at?: string | null;
  seen_at: string | null;
  last_interaction_at: string | null;
  completed_at: string | null;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  assigned_to_user_id: string | null;
  /** Embedded via Supabase left-join: projects(id, name, name_he, color, parent_id) */
  projects?: { id: string; name: string; name_he: string | null; color: string | null; parent_id: string | null } | null;
  source_message_id: string | null;
  /** Embedded via Supabase left-join: source_messages(id, source_type, source_url, serial_display) */
  source_messages?: { id?: string | null; source_type: string | null; source_url: string | null; serial_display: string | null } | null;
  task_type: "action" | "project_suggestion" | "brief_review" | "followup" | "meeting";
  /** Human-readable serial: T1, T2, ... — assigned by DB trigger */
  serial_display: string;
  /** First task of a recurring series this instance belongs to (null = standalone). */
  recurrence_parent_id?: string | null;
  /** Series stop date (null = open-ended). */
  recurrence_until?: string | null;
  /**
   * Medium-confidence cross-source duplicate suggestion set by ai-process:
   * the id of an existing open task this one may duplicate. Null when there is
   * no suggestion. High-confidence matches are auto-linked and never land here.
   */
  suggested_duplicate_of: string | null;
  /** Embedded via Supabase left-join on suggested_duplicate_of. */
  suggested_duplicate?: { id: string; title: string; title_he: string | null; serial_display: string } | null;

  // ── smrtPlan layer (migration 20260604000100) ──────────────────────────────
  /** The plan this task belongs to (smrtPlan). Mutually exclusive with project_id in practice. */
  plan_id?: string | null;
  /** The plan stage (banner) this task is grouped under, if any. */
  stage_id?: string | null;
  /** Parent task — this is a sub-task (a unit of work in the engine). */
  parent_task_id?: string | null;
  /** Engine: effective duration in working days (computed unless duration_manual). */
  duration_days?: number | null;
  /** True when a human pinned duration_days by hand (engine then leaves it alone). */
  duration_manual?: boolean | null;
  /** Effort estimate in hours (direct or from the estimates catalog). */
  estimated_hours?: number | null;
  /** Engine: forward-pass earliest start (date). */
  earliest_start?: string | null;
  /** Engine: backward-pass latest start the plan deadline allows (date). */
  latest_start?: string | null;
  /** Engine: backward-pass latest finish the plan deadline allows (date). */
  latest_finish?: string | null;
  /** Engine: on the critical path (slack = 0). */
  is_critical?: boolean | null;
  /** Plan + stage names, attached at runtime by /api/plan/my-tasks (not columns). */
  plan_title_he?: string | null;
  plan_title_en?: string | null;
  stage_name_he?: string | null;
  stage_name_en?: string | null;
  /** Assignment model: assigned tasks are 'accepted' immediately; peer offers are 'proposed'. */
  assignment_status?: "proposed" | "accepted" | "declined" | null;
  proposed_by?: string | null;
  proposed_at?: string | null;
  accepted_at?: string | null;
  /** Worker asked for this assigned task to be removed (escalation, not a decline). */
  deletion_requested?: boolean | null;
  /** Private (owner-only) vs organizational. Default true so existing tasks stay private. */
  is_private?: boolean | null;
  /**
   * "What's needed to start" — the inbound task→task dependencies, resolved by the
   * backend from smrtplan_dependencies. Each entry is a provider task this task waits on.
   */
  needs?: TaskNeed[];
  /** Where this task hands off when completed (the dependent tasks waiting on it). */
  handoff?: TaskHandoff[];
}

/** One "what's needed to start" input, resolved from smrtplan_dependencies (task→task). */
export interface TaskNeed {
  /** The dependency row id (for satisfying / removing). */
  dependency_id: string;
  /** The provider task id (null when the requirement is external, e.g. a Drive file). */
  task_id: string | null;
  /** "task" (default) or "plan" — a dependency on a whole plan / capability. */
  provider_kind?: "task" | "plan";
  /** The provider plan id, when provider_kind === "plan". */
  plan_id?: string | null;
  /** For a capability provider: it is done but currently flipped unavailable
   *  (re-blocks this open dependent). satisfied stays false in that case. */
  unavailable?: boolean;
  title: string;
  /** Whoever owns the provider (assignee display name / source). */
  source?: string | null;
  /** The provider task's assignee user id (resolved to a name client-side). */
  assignee_user_id?: string | null;
  /** true once the provider task is complete (the input "arrived"). */
  satisfied: boolean;
  /** true when the edge is satisfied but the provider task has since been
   *  reopened — the input this task relies on is back in progress. */
  provider_reopened?: boolean;
  /** Working-day buffer between the provider's finish and this task's start. */
  lag_days?: number;
  /** External material link (entity_links requires), when not a task. */
  url?: string | null;
}

/** One downstream task that this task feeds when completed. */
export interface TaskHandoff {
  dependency_id: string;
  task_id: string;
  title: string;
}
