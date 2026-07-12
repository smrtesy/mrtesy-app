/**
 * Day-tools registry — the single source of truth for the "כלי היום" add-ons
 * that sit on top of the tasks/suggestions system. Each tool is a toggle in
 * settings plus a small per-tool config, all stored in one JSONB column
 * (`user_settings.day_tools`, keyed by slug). See docs/day-tools-plan.md.
 *
 * Adding a new tool = add an entry here + its i18n keys (dayTools.<slug>.*)
 * + the component that hangs off one of the anchor points. No migration.
 */

export type DayToolSlug = "method131" | "marathon" | "planfocus";

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
 */
export const DAY_TOOLS: readonly DayToolDef[] = [
  { slug: "method131", defaultConfig: { enabled: true, medium_quota: 3, big_quota: 1 } },
  { slug: "marathon", defaultConfig: { enabled: true } },
  { slug: "planfocus", defaultConfig: { enabled: false } },
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
