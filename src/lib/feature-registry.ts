/**
 * Feature registry — the STRUCTURE half of feature-channels
 * (docs/feature-channels-plan.md §3). A thin, code-owned index — same spirit as
 * site-map.ts — of every channel-gated feature: what it is, which screen it
 * belongs to, where it lives in code, and its migration intent.
 *
 * STRUCTURE (this file) vs STATE (the `feature_channels` DB table): this file
 * says a feature EXISTS and where; the table says what is enabled per channel,
 * which version, and when it changed. The split is deliberate — the push hook
 * (.claude/hooks/feature-registry-guard.sh) can only see `git diff`, so it
 * enforces that every channel-gated feature in code is registered HERE; the
 * dynamic state lives in the DB where the /admin/features screen edits it with
 * zero AI at read time.
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

/** `fork` = permanent intended split, no deadline. `migrate` = beta will
 *  eventually replace stable; carries an optional soft `promote_by` date. */
export type FeatureIntent = "fork" | "migrate";

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
  /** `fork` (permanent split) or `migrate` (beta replaces stable eventually). */
  intent: FeatureIntent;
  /** Where the feature lives in code — the component/dir a reader jumps to. */
  codeRef: string;
  /** True when this feature is a V1/V2 fork (gate B, `version` picks the
   *  component). False/omitted for a plain show/hide feature (gate A). */
  hasVersions?: boolean;
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
    intent: "fork",
    codeRef: "src/components/smrttask/whatsapp/WhatsAppReader.tsx",
  },
  {
    featureId: "day-tools.focus-plan",
    screenKey: "/day-tools",
    title: "Focus plan",
    titleHe: "פוקוס תוכנית",
    intent: "fork",
    codeRef: "src/components/smrttask/day-tools/",
  },
] as const;

/** Fast lookup by featureId. */
export const FEATURE_BY_ID: Readonly<Record<string, FeatureRegistryEntry>> =
  Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.featureId, f]));

/** Every registered feature for a screen, in registry order. */
export function featuresForScreen(screenKey: string): FeatureRegistryEntry[] {
  return FEATURE_REGISTRY.filter((f) => f.screenKey === screenKey);
}
