"use client";

/**
 * FeatureIdContext — publishes the featureId of the nearest enclosing
 * <FeatureGate> so descendants can tag telemetry to the right feature
 * (docs/feature-channels-plan.md §8, "feature log from two sources").
 *
 * Two consumers:
 *   • the "report a problem" button (a genuine descendant when it sits inside a
 *     gated feature) — reads it via the useCurrentFeatureId() hook;
 *   • PaneHost's PaneErrorBoundary — a class component that reads it via
 *     `static contextType`. When the boundary is not inside any FeatureGate the
 *     value is null and the caller falls back to the screen key from the path.
 *
 * Deliberately tiny and provider-only so FeatureGate can wrap its subtree with
 * zero extra render cost and no change to its public signature.
 */

import { createContext, useContext } from "react";

/** Null when no <FeatureGate> is above this point in the tree. */
export const FeatureIdContext = createContext<string | null>(null);

/** The featureId of the nearest enclosing <FeatureGate>, or null outside one. */
export function useCurrentFeatureId(): string | null {
  return useContext(FeatureIdContext);
}
