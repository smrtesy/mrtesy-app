/**
 * Day-tools registry — the single source of truth for the "כלי היום" add-ons
 * that sit on top of the tasks/suggestions system. Each tool is a toggle in
 * settings plus a small per-tool config, all stored in one JSONB column
 * (`user_settings.day_tools`, keyed by slug). See docs/day-tools-plan.md.
 *
 * Adding a new tool = add an entry here + its i18n keys (dayTools.<slug>.*)
 * + the component that hangs off one of the anchor points. No migration.
 */

export type DayToolSlug = "method131" | "marathon" | "planfocus" | "workclock" | "dailyreport";

export interface DayToolConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface DayToolDef {
  slug: DayToolSlug;
  /** i18n keys resolve to dayTools.<slug>.title / .desc */
  defaultConfig: DayToolConfig;
}

/**
 * Registry order = display order in the settings section.
 *
 * - method131  — the מהיר·3·1 desk method (the current desk UI). Default ON
 *   for existing users so nothing changes for them when the framework ships.
 * - marathon   — the full-screen timed quick-task run. Default ON (it is a
 *   quiet icon button; users who never press it are unaffected).
 * - planfocus  — the daily focus block over a smrtPlan project. Default OFF —
 *   a deliberate, opt-in tool.
 * - workclock  — the guided workday: a running work clock + morning ritual +
 *   run mode with escalating time limits + end-of-day close. Default OFF — a
 *   deliberate, opt-in tool. Config keys are FLAT (not nested objects) because
 *   the server merges day_tools at the tool-key level (a PATCH replaces the
 *   whole tool object), and resolveTool below merges shallowly. See
 *   docs/workclock-plan.md §3.
 */
export const DAY_TOOLS: readonly DayToolDef[] = [
  { slug: "method131", defaultConfig: { enabled: true, medium_quota: 3, big_quota: 1 } },
  { slug: "marathon", defaultConfig: { enabled: true } },
  { slug: "planfocus", defaultConfig: { enabled: false } },
  {
    slug: "workclock",
    defaultConfig: {
      enabled: false,
      offer_daily: true,
      // Morning-ritual step timers (seconds).
      step_inbox_sec: 180,
      step_plan_sec: 180,
      step_run_sec: 30,
      // Run-mode escalation thresholds (seconds).
      limit_quick_task_sec: 300,     // 5m  → soft red
      limit_quick_total_sec: 2700,   // 45m → popup banner
      limit_medium_task_sec: 2700,   // 45m → blocking screen
      limit_big_task_sec: 10800,     // 3h  → blocking screen
      // Pause nag + sound.
      pause_nag_sec: 300,
      sound_enabled: true,
      // End-of-day close (wall-clock times in close_tz).
      close_tz: "America/New_York",
      close_remind_at: "18:55",
      close_prompt_at: "19:20",
      close_autostop_sec: 300,
    },
  },
  {
    // Daily report — user-defined daily self-report questions (each answer with
    // an optional score). A weekly report (answer tallies + average score +
    // completed-task metrics) is delivered to the inbox every Tuesday. Default
    // OFF — an opt-in tool. Config keys are FLAT (server merges at tool-key
    // level). See docs/daily-report-plan.md.
    slug: "dailyreport",
    defaultConfig: {
      enabled: false,
      period: "weekly",   // 'weekly' | 'monthly'
      // Hour-of-day (0–23) the report is delivered, in the user's timezone
      // (user_settings.timezone; defaults to America/New_York server-side).
      report_hour: 8,
    },
  },
] as const;

const BY_SLUG: Record<DayToolSlug, DayToolDef> =
  Object.fromEntries(DAY_TOOLS.map((d) => [d.slug, d])) as Record<DayToolSlug, DayToolDef>;

/** The raw `day_tools` JSONB map as stored on user_settings. */
export type DayToolsState = Partial<Record<DayToolSlug, Partial<DayToolConfig>>>;

/**
 * Resolve one tool's effective config: the registry default overlaid with any
 * stored overrides. Guarantees `enabled` and every default key are present, so
 * callers never deal with undefined.
 */
export function resolveTool(state: DayToolsState | null | undefined, slug: DayToolSlug): DayToolConfig {
  const def = BY_SLUG[slug];
  const stored = state?.[slug] ?? {};
  return { ...def.defaultConfig, ...stored } as DayToolConfig;
}

/** Convenience: is this tool enabled (default-aware)? */
export function isToolEnabled(state: DayToolsState | null | undefined, slug: DayToolSlug): boolean {
  return resolveTool(state, slug).enabled;
}
