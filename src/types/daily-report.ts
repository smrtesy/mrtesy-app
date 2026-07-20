/**
 * Daily-report day-tool client types. Mirrors the server shapes in
 * server/src/modules/smrttask/daily-report/*. See docs/daily-report-plan.md.
 */

/** One answer option of a report question. `score` is optional. */
export interface DailyReportOption {
  id?: string;
  label: string;
  score: number | null;
  position?: number;
}

/** One report question (item). */
export interface DailyReportItem {
  id?: string;
  label: string;
  position?: number;
  options: DailyReportOption[];
}

/** Today's saved answer for one item (from GET /daily-report/today). */
export interface DailyReportTodayEntry {
  option_id: string | null;
  option_label: string;
  score: number | null;
}

export interface DailyReportToday {
  date: string;
  entries: Record<string, DailyReportTodayEntry>;
  done: boolean;
  active_count: number;
}

// ── computed report ──────────────────────────────────────────────────────────

export interface ReportOptionTally {
  label: string;
  count: number;
  score: number | null;
}
export interface ReportItemResult {
  item_id: string;
  label: string;
  avg_score: number | null;
  answered: number;
  options: ReportOptionTally[];
}
export interface ReportTasks {
  quick: number;
  medium: number;
  big: number;
  worked_seconds: number;
}
export interface DailyReport {
  period_type: "weekly" | "monthly";
  range_start: string;
  range_end: string;
  overall_score: number | null;
  items: ReportItemResult[];
  tasks: ReportTasks;
}

export interface DailyReportRun {
  id: string;
  period_type: "weekly" | "monthly";
  range_start: string;
  range_end: string;
  overall_score: number | null;
  breakdown: { items: ReportItemResult[]; tasks: ReportTasks };
  generated_by: "schedule" | "manual";
  created_at: string;
}
