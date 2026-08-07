/**
 * Feature registry — the STRUCTURE half of feature-channels
 * (docs/feature-channels-plan.md §3). A thin, code-owned index — same spirit as
 * site-map.ts — of every channel-gated feature: what it is, which screen it
 * belongs to, where it lives in code, and its version history.
 *
 * STRUCTURE (this file) vs STATE (the `feature_channels` DB table): this file
 * says a feature EXISTS, where it lives, and WHICH VERSIONS it has (each with a
 * date + one-line "what changed" — written by Claude the same commit it touches
 * the code). The table says only what is enabled per channel, which version each
 * channel points at, and the human note. The split is deliberate — the push
 * hook (.claude/hooks/feature-registry-guard.sh) can only see `git diff`, so it
 * enforces that every channel-gated feature in code is registered HERE; the
 * dynamic state lives in the DB where the /admin/features screen edits it with
 * zero AI at read time.
 *
 * WHY versions live here, not in the DB: "what does v1 do vs v2" is a fact about
 * the CODE — it changes only when Claude writes the code. So Claude records it
 * here (structure), the same commit. The admin screen never edits it: the screen
 * only routes which channel sees which version (state → DB). The `versions` list
 * therefore feeds BOTH the version picker (its available options) AND the
 * per-feature history drawer (date · version · summary). A single-version
 * feature shows no picker.
 *
 * Add an entry the SAME commit you add a channel-gated feature (a `<FeatureGate>`
 * with a new featureId, or a V1/V2 fork). The GET /api/admin/features endpoint
 * crosses this registry against the `feature_channels` rows, so a feature with
 * no entry here is invisible in the admin screen.
 *
 * This file is the SOURCE OF TRUTH. A server twin — server/src/lib/feature-registry.ts
 * — mirrors the STRUCTURE half (the backend has rootDir ./src and cannot import
 * this file), same "keep in sync" rule as the permissions registry twin. Adding
 * or editing an entry here means editing the twin in the SAME commit.
 */

/** One version of a feature — recorded by Claude when it writes/changes the
 *  code. `date` is when this version landed (YYYY-MM-DD, America/New_York).
 *  `summary` is a two-to-three-word "what changed" (English), `summaryHe` its
 *  Hebrew twin shown in the history drawer. */
export type FeatureVersion = {
  version: string;
  date: string;
  summary: string;
  summaryHe?: string;
};

export type FeatureRegistryEntry = {
  /** kebab-case, globally unique. Nested features use a dotted prefix of their
   *  screen, e.g. "day-tools.focus-plan". Mirrors feature_channels.feature_id. */
  featureId: string;
  /** Screen path from site-map.ts, e.g. "/whatsapp". Groups features in the
   *  admin screen and ties a feature to its screen for the error log. */
  screenKey: string;
  /** Human title (English). */
  title: string;
  /** Hebrew title, shown in the admin screen when present. */
  titleHe?: string;
  /** Where the feature lives in code — the component/dir a reader jumps to. */
  codeRef: string;
  /** Every version this feature has had, oldest→newest. Drives the version
   *  picker (options) and the history drawer. A feature with a single entry
   *  shows no picker. Omit for a plain show/hide feature that never forked. */
  versions?: FeatureVersion[];
};

/**
 * The registered features. Seeded with the two examples the plan names; extend
 * this as features get channel-gated. Keep entries grouped by screenKey in the
 * order screens appear in SITE_MAP so the admin screen reads top-to-bottom.
 */
export const FEATURE_REGISTRY: readonly FeatureRegistryEntry[] = [
  {
    featureId: "whatsapp-reader",
    screenKey: "/whatsapp",
    title: "WhatsApp reader",
    titleHe: "קורא וואטסאפ",
    codeRef: "src/components/smrttask/whatsapp/WhatsAppReader.tsx",
    versions: [
      { version: "v1", date: "2026-08-07", summary: "Initial version", summaryHe: "גרסה ראשונית" },
    ],
  },
  {
    featureId: "day-tools.focus-plan",
    screenKey: "/day-tools",
    title: "Focus plan",
    titleHe: "פוקוס תוכנית",
    codeRef: "src/components/smrttask/day-tools/",
    versions: [
      { version: "v1", date: "2026-08-07", summary: "Initial version", summaryHe: "גרסה ראשונית" },
    ],
  },
] as const;

/** Fast lookup by featureId. */
export const FEATURE_BY_ID: Readonly<Record<string, FeatureRegistryEntry>> =
  Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.featureId, f]));

/** Every registered feature for a screen, in registry order. */
export function featuresForScreen(screenKey: string): FeatureRegistryEntry[] {
  return FEATURE_REGISTRY.filter((f) => f.screenKey === screenKey);
}

/** The version strings a feature offers, oldest→newest (picker options). */
export function versionOptions(entry: FeatureRegistryEntry): string[] {
  return (entry.versions ?? []).map((v) => v.version);
}
