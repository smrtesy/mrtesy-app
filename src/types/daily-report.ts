/**
 * Daily-report day-tool client types. Mirrors the server shapes in
 * server/src/modules/smrttask/daily-report/*. See docs/daily-report-plan.md.
 */

export type ReportSegment = "start" | "end";

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
  /** 'end' closes yesterday, 'start' opens today. */
  segment: ReportSegment;
  /** Weekday numbers (0=Sun..6=Sat) it applies to; null = every day. */
  weekdays: number[] | null;
  options: DailyReportOption[];
}

// ── check-in ─────────────────────────────────────────────────────────────────

export interface CheckinItem {
  id: string;
  label: string;
  options: { id: string; label: string; score: number | null }[];
  selected_option_id: string | null;
}
export interface CheckinSection {
  segment: ReportSegment;
  entry_date: string; // YYYY-MM-DD the section's answers belong to
  items: CheckinItem[];
}
export interface DailyReportCheckin {
  fill_date: string;
  sections: CheckinSection[];
  done: boolean;
  total_due: number;
  answered: number;
}

/** One incomplete fill-day (a pinned "fill your report" row). */
export interface PendingDay {
  fill_date: string;
  total_due: number;
  answered: number;
  is_today: boolean;
}
export interface DailyReportPending {
  today: string;
  days: PendingDay[];
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
  segment: ReportSegment;
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
