/**
 * Feature registry — SERVER TWIN of src/lib/feature-registry.ts.
 *
 * The frontend registry is the source of truth (the push hook
 * .claude/hooks/feature-registry-guard.sh enforces that every channel-gated
 * feature in code is registered there). The Express backend has
 * `rootDir: ./src`, so it cannot import the frontend file — this twin mirrors
 * the STRUCTURE half so `GET /admin/features` can cross the registry against
 * the `feature_channels` state rows server-side, and `PATCH` can backfill
 * screen_key/title/title_he for a new row.
 *
 * KEEP IN SYNC with src/lib/feature-registry.ts — same rule as the permissions
 * registry twin (server/src/lib/permissions/registry.ts). Add/edit an entry in
 * BOTH files in the same commit.
 */

export type FeatureIntent = "fork" | "migrate";

export type FeatureRegistryEntry = {
  featureId: string;
  screenKey: string;
  title: string;
  titleHe?: string;
  intent: FeatureIntent;
  codeRef: string;
  hasVersions?: boolean;
};

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

export const FEATURE_BY_ID: Readonly<Record<string, FeatureRegistryEntry>> =
  Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.featureId, f]));
