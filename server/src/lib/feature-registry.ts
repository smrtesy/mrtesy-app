/**
 * Feature registry — SERVER TWIN of src/lib/feature-registry.ts.
 *
 * The frontend registry is the source of truth (the push hook
 * .claude/hooks/feature-registry-guard.sh enforces that every channel-gated
 * feature in code is registered there). The Express backend has
 * `rootDir: ./src`, so it cannot import the frontend file — this twin mirrors
 * the STRUCTURE half so `GET /admin/features` can cross the registry against
 * the `feature_channels` state rows server-side (including the version list,
 * which the picker + history drawer read), and `PATCH` can backfill
 * screen_key/title/title_he for a new row.
 *
 * KEEP IN SYNC with src/lib/feature-registry.ts — same rule as the permissions
 * registry twin (server/src/lib/permissions/registry.ts). Add/edit an entry in
 * BOTH files in the same commit.
 */

export type FeatureVersion = {
  version: string;
  date: string;
  summary: string;
  summaryHe?: string;
};

export type FeatureRegistryEntry = {
  featureId: string;
  screenKey: string;
  title: string;
  titleHe?: string;
  codeRef: string;
  versions?: FeatureVersion[];
};

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

export const FEATURE_BY_ID: Readonly<Record<string, FeatureRegistryEntry>> =
  Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.featureId, f]));

/** The version strings a feature offers, oldest→newest (picker options). */
export function versionOptions(entry: FeatureRegistryEntry): string[] {
  return (entry.versions ?? []).map((v) => v.version);
}
