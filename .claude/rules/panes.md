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
