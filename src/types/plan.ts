/**
 * smrtPlan domain types — the planning layer over smrtTask.
 *
 * A Plan is born in smrtPlan (vs a Project, born in smrtTask). It is either an
 * `effort` (a container of tasks shown as a list) or a `stream` (an episode ×
 * stage matrix). Plans form a hierarchy via parent_id and are grouped on the
 * board by group_label.
 */

export type PlanKind = "effort" | "stream";
export type PlanStage = "idea" | "shaping" | "active";

export interface Plan {
  id: string;
  org_id: string;
  parent_id: string | null;
  project_id: string | null;
  title_he: string;
  title_en: string | null;
  goal: string | null;
  kind: PlanKind;
  group_label: string | null;
  /** ISO date. null => the plan lives in the repository (off the timeline). */
  start_date: string | null;
  end_date: string | null;
  stage: PlanStage;
  /** 0..1 computed progress. */
  progress: number;
  /** 0..1 manual override (null = use computed). */
  progress_manual: number | null;
  is_critical: boolean;
  color: string | null;
  is_private: boolean;
  owner_user_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;

  // Derived / joined (populated by the API, optional)
  /** effective_progress = progress_manual ?? computed. */
  effective_progress?: number;
  /** Health vs the path: on_track / at_risk / late. */
  health?: PlanHealth;
  /** Convenience counts for effort plans. */
  task_count?: number;
  completed_task_count?: number;
}

export type PlanHealth = "on_track" | "at_risk" | "late" | "stream" | "flex";

export interface PlanStageRow {
  id: string;
  org_id: string;
  plan_id: string;
  name_he: string;
  name_en: string | null;
  sequence: number;
  required_role: string | null;
}

export interface PlanEpisode {
  id: string;
  org_id: string;
  plan_id: string;
  name_he: string;
  name_en: string | null;
  family: string | null;
  due_date: string | null;
  sequence: number;
}

export type CellStatus = "todo" | "prog" | "done";

export interface EpisodeStageStatus {
  id: string;
  org_id: string;
  episode_id: string;
  stage_id: string;
  status: CellStatus;
  task_id: string | null;
  completed_at: string | null;
}

export type DependencyEnd = "plan" | "stage" | "task";

export interface PlanDependency {
  id: string;
  org_id: string;
  from_type: DependencyEnd;
  from_id: string;
  to_type: DependencyEnd;
  to_id: string;
  satisfied: boolean;
  created_at: string;
}

/** Full stream view payload: the matrix for one stream plan. */
export interface StreamMatrix {
  plan: Plan;
  stages: PlanStageRow[];
  episodes: PlanEpisode[];
  /** Keyed `${episode_id}:${stage_id}` → cell. */
  cells: Record<string, EpisodeStageStatus>;
}

/** A significant date marked on the board (designer leaves, go-live, …). */
export interface PlanMilestone {
  id: string;
  /** null = global (crosses all rows); otherwise tied to one plan row. */
  plan_id: string | null;
  milestone_date: string;
  label_he: string;
  label_en: string | null;
  color: string | null;
}

/** Access level for the current user in smrtPlan (full = creator, lite = consumer). */
export type PlanAccessLevel = "full" | "lite";
