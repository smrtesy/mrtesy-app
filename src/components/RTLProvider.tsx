"use client";

import { DirectionProvider } from "@radix-ui/react-direction";

/**
 * Thin client wrapper so the layout (a server component) can hand a `dir`
 * down to the Radix context. Without this, Radix primitives that call
 * `useDirection()` — ScrollArea, Tabs, Slider, etc. — silently fall back
 * to LTR no matter what `<html dir>` says.
 */
export function RTLProvider({ dir, children }: { dir: "ltr" | "rtl"; children: React.ReactNode }) {
  return <DirectionProvider dir={dir}>{children}</DirectionProvider>;
}
