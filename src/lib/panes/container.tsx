"use client";

/**
 * Pane container context (companion to src/lib/panes/nav.tsx).
 *
 * A screen rendered inside a tabs-workspace pane is NOT full-viewport — it
 * occupies one rectangle in a side-by-side row of panes. A modal opened by
 * such a screen (the task window) must stay inside that rectangle instead of
 * covering the whole app: a `fixed inset-0` overlay portalled to <body> would
 * blanket the sidebar and every sibling pane and — because Radix's modal mode
 * locks body scroll + pointer-events — freeze them too.
 *
 * PaneHost exposes its pane box through this context. A dialog that reads it
 * portals into the box and positions itself `absolute` within it (non-modal,
 * so the rest of the workspace stays live). Outside a pane the hook returns
 * null and dialogs keep their normal full-screen modal behaviour.
 */

import { createContext, useContext, type ReactNode } from "react";

const PaneContainerContext = createContext<HTMLElement | null>(null);

export function PaneContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PaneContainerContext.Provider value={container}>
      {children}
    </PaneContainerContext.Provider>
  );
}

/** The current pane's box element, or null when not rendered inside a pane. */
export function usePaneContainer(): HTMLElement | null {
  return useContext(PaneContainerContext);
}
