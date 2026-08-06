"use client";

import { useAppAccess } from "@/contexts/AppAccessContext";
import { FeatureIdContext } from "./FeatureIdContext";

/**
 * Feature-channels client gate (docs/feature-channels-plan.md). Orthogonal to
 * permissions/ResourceGuard: that answers "is the user ALLOWED this?", this
 * answers "does this user's maturity channel SEE this feature yet?".
 *
 * The per-channel feature view is resolved once server-side in (app)/layout.tsx
 * from the `feature_channels` table and published via AppAccessContext, so this
 * reads it with zero AI and zero extra round-trips.
 */

/**
 * Read the channel-resolved state for a single feature. When the feature has no
 * `feature_channels` row yet, the default follows plan §7.3: an UNREGISTERED
 * feature is visible in beta (so work-in-progress is dogfooded) and hidden in
 * stable (so customers never catch it early); its version defaults to "v1".
 */
export function useFeature(featureId: string): { visible: boolean; version: string } {
  const { features, channel } = useAppAccess();
  return features[featureId] ?? { visible: channel === "beta", version: "v1" };
}

/**
 * Wrap a subtree that belongs to a channel-gated feature. Renders the children
 * only when the user's channel sees the feature; otherwise nothing — same shape
 * as ResourceGuard, so the wrapped screen's hooks never run when it's hidden.
 *
 * When visible, the subtree is also wrapped in FeatureIdContext so descendants
 * (the error boundary, the "report a problem" button) can tag telemetry to this
 * featureId — see FeatureIdContext.tsx. The public signature is unchanged.
 */
export function FeatureGate({
  featureId,
  children,
}: {
  featureId: string;
  children: React.ReactNode;
}) {
  const { visible } = useFeature(featureId);
  if (!visible) return null;
  return <FeatureIdContext.Provider value={featureId}>{children}</FeatureIdContext.Provider>;
}
