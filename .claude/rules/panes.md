---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/lib/panes/**"
---

# Tabs-workspace panes — hard rules for any screen work

Sidebar screens render as component panes via `src/lib/panes/registry.tsx`;
unregistered routes fall back to an iframe pane automatically (this fallback is
permanent — detail routes, /projects, /settings and /admin use it by design).
When you add or change a screen that can render in a pane:

- Register it in the registry with a wrapper that mirrors the route page's
  markup 1:1.
- Use `useScreenSearchParams` / `useScreenPathname` / `useScreenRouter` and
  `PaneLink` from `@/lib/panes/nav` instead of next/navigation and next/link —
  they are byte-identical outside a pane.
- Never write `document.body` / `documentElement` attributes without a
  `useOptionalPaneNav()` guard (in a pane they leak onto the top window).
- No `100dvh`/viewport heights inside pane-capable screens — use `h-full`
  (chat-style screens get `fullHeight: true` in the registry).
- Links that should open a SIBLING tab (not swap the pane) go through
  `OpenTabLink`.

Full picture: `docs/router-panes-plan.md`. Reference implementation of the
compact-UI collapsed-search pattern:
`src/components/smrttask/whatsapp/WhatsAppReader.tsx`.

## Breadcrumbs — standing rule for every hierarchical screen

Any screen that has a hierarchy (a path of levels the user drills into —
e.g. Production › project › script) MUST show a breadcrumb at the
**top-left of the screen** (a top row), **always visible** (not only after
drilling in), with a chevron between each level and every level except the
last navigable — a `href` to jump there, or an `onClick` to collapse/return
in place. This is a user standing preference (2026-07), not per-screen taste.

Use the shared component `src/components/ui/breadcrumbs.tsx`
(`<Breadcrumbs items={[{label, href?, onClick?}]} />`) — do NOT hand-roll a
breadcrumb, so the look and behavior stay identical everywhere. It renders
`dir="ltr"` so the path reads left→right. Reference wiring (lifting the
drilled-into level up so the top breadcrumb can name and collapse it):
`src/components/smrtstudio/StudioProject.tsx` (Production › project ›
open-script).
