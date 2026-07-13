# Router-based panes — migration plan (replacing iframe panes)

Status: **planned** (approved direction; implementation not started)
Owner: Claude sessions; each phase runs the full pre-push protocol.

## 1. Goal and UX contract

Replace the `<iframe>` body of each tabs-workspace pane with a directly-rendered
React component, keeping the tabs UX **pixel-identical**:

- Same pane headers, close buttons, draggable dividers, active-pane sizing,
  WhatsApp-pane left-pinning, localStorage persistence (`smrtesy.tabs.v1`).
- Opening a pane becomes a component mount (~tens of ms) instead of a full
  document load (~0.5–1.5s): no middleware pass, no layout auth queries, no
  bundle re-parse, no hydration.
- All panes share ONE React tree: one QueryClient (data fetched in one pane is
  warm in another), one realtime channel set, one copy of the app in memory.
- A pane keeps its internal state (scroll, filters, drafts) while open —
  exactly as iframes do today, because panes stay mounted side by side.

## 2. Why iframes are expensive (measured facts)

Every pane is a full document: `TabsWorkspace.tsx:204` renders
`<iframe src={withEmbed(tab.href)}>`. Each open therefore pays middleware
(auth), the `(app)` layout queries, script parse + hydration, and a cold
client-side data fetch. Panes are isolated JS contexts, so nothing is shared:
N panes = N QueryClients, N realtime sockets, N polls (Sidebar 180s,
UpcomingBanner 60s, …), N × app memory. A whole support layer exists only to
tame this: `?embed=1` + `data-embed` CSS strips (`globals.css:110-141`),
`EmbedFlag`, `isEmbeddedPane()`, `navigateTop()`, and the
`postMessage`/`requestOpenTab` bridge (`navigate.ts:59`,
`TabsWorkspaceContext.tsx:140-150`) — all deletable once panes are components.

## 3. Current architecture (mapped 2026-07-13)

- `TabsWorkspaceContext` — tab set `{id=href, href, label}`, active id, widths;
  persisted to localStorage; dedupes by href (a screen can never be open twice).
- `TabsArea` — with open tabs on desktop, **replaces** the route's `children`
  with `<TabsWorkspace/>`; the browser URL is decoupled from what panes show.
- `Sidebar` — `preventDefault()` + `openTab()` on every entry
  (`Sidebar.tsx:314,423,595`).
- In-pane links that should open a sibling pane use `OpenTabLink` →
  postMessage to the top window.

### Screen inventory (route → client component)

Thin wrappers (server page only does `getTranslations` + render):
`/tasks`→TasksPageClient, `/log`→LogPageClient, `/whatsapp`→WhatsAppPageClient,
`/whatsapp/autoreply`→AutoReplyManager, `/sms`→SmsPageClient,
`/crm`→ContactsClient+CrmManagePanel, `/reach`→CampaignsClient,
`/bots`→BotsClient, `/plan`→PlanBoardClient, `/plan/team`→TeamViewClient,
`/plan/repository`→PlanRepositoryClient, `/vault`→VaultClient,
`/voice`→VoiceNav+ProjectsList, `/voice/characters`→CharactersList,
`/knowledge`→KnowledgeCenter.

Pages with real server-side work (NOT thin): `/inbox` (org/app_memberships
fetch), `/projects` (projects + counts), `/settings`
(getEnabledAppsForActiveOrg), `/admin` (counts + fs). These stay iframe-backed
until Phase 3.

### next/navigation coupling (the crux)

| Screen | Coupling | Migration need |
|---|---|---|
| TaskList | `useSearchParams` `?focus=`, `router.replace(pathname?qs)` to strip it, `usePathname` | pane-nav shim |
| SettingsTabs | tabs ARE sibling routes via `router.replace` | keep iframe until Phase 3 or refactor to local state |
| ThreadView (whatsapp) | `?draft` read + `history.replaceState` | pane-nav shim |
| WhatsAppPageClient / SmsPageClient | `?chat_id`, `?msg` | pane-nav shim |
| VoiceNav | `usePathname` for active tab; `Link` between /voice/* | pane-nav shim + in-pane nav |
| BotsClient / CampaignsClient | `Link` to detail routes | in-pane nav or open-as-tab |
| LogPageClient, ContactsClient, VaultClient, PlanBoardClient, TeamViewClient, PlanRepositoryClient, WhatsAppReader | **none** | free — migrate first |

### Singleton inventory (one shared tree)

Realtime channel names are fixed (`"tasks-realtime"` TaskList.tsx:343,
`"notifications-list"`, `"sidebar-inbox-count"`): safe today because tab
dedupe prevents the same screen twice, but each migrated screen must either
keep that invariant or get a unique channel suffix. Global window events
(`smrtesy:badge-refresh`, `smrtesy:active-org-changed`) become simpler — one
listener, one dispatcher. `data-*` attributes on body/html (sidebar-collapsed,
wa-panel) are already top-window-only. Toaster lives in `[locale]/layout` —
already shared.

## 4. Target architecture

### 4.1 Screen registry

```ts
// src/lib/panes/registry.tsx
type PaneScreen = {
  match: (path: string) => boolean;          // path without locale prefix
  render: (ctx: { locale: string }) => ReactNode;
};
export const PANE_SCREENS: PaneScreen[] = [ /* filled per phase */ ];
export function resolvePaneScreen(href: string): PaneScreen | null;
```

Resolution strips the locale prefix from `tab.href` and finds the first match.
`null` → the pane renders the **legacy iframe** exactly as today. This is the
core safety property: unmigrated (or newly added) routes silently keep
working; migration is per-screen and reversible by deleting a registry entry.

### 4.2 PaneHost (replaces the iframe body only)

`TabsWorkspace` keeps 100% of its layout/drag/header code. The pane body
becomes:

```tsx
<PaneHost tab={tab} active={active} />
// = registered ? (
//     <PaneNavProvider tab={tab}>
//       <PaneErrorBoundary>{screen.render({ locale })}</PaneErrorBoundary>
//     </PaneNavProvider>
//   ) : <iframe src={withEmbed(tab.href)} …/>   // legacy fallback
```

Each component pane is wrapped in an error boundary so one crashing screen
cannot take down the workspace (iframes gave this isolation for free).

### 4.3 Pane navigation shim

A pane-scoped nav state lives in the tab entry (extend `WorkspaceTab` with
`path` + `search`, persisted like everything else):

```ts
type PaneNav = {
  pathname: string;                 // pane-local, locale-stripped
  searchParams: URLSearchParams;    // pane-local
  push(href): void;    // registered ? swap pane content : swap pane to iframe
  replace(href): void; // same, no history semantics needed (no stack v1)
};
```

Compatibility hooks in `src/lib/panes/nav.ts`:

```ts
useScreenSearchParams() // = PaneNav.searchParams inside a pane, else useSearchParams()
useScreenPathname()
useScreenRouter()       // {push, replace} — PaneNav inside a pane, else next/navigation
```

Migrating a screen = swapping its `next/navigation` imports for these hooks
(mechanical; the table above lists exactly which screens need it). Outside a
pane the hooks are byte-for-byte the old behavior, so mobile and full-page
rendering are untouched.

`OpenTabLink` becomes a direct `openTab()` call when a provider exists
(same tree now); the postMessage path stays until the last iframe dies.

### 4.4 What component panes do NOT render

The screen component only — no `(app)` layout, no Sidebar, no WhatsApp FAB.
So the whole `data-embed` strip layer is unnecessary for them. It stays in
place, untouched, for legacy iframe panes until Phase 3 removes it.

### 4.5 Explicitly rejected alternatives

- **Next parallel routes (`@slot`)** — slot count is static, arbitrary N panes
  and per-pane URLs don't fit; interception rules are notoriously brittle.
- **Keeping iframes + warming them** — already done (auth-chain work,
  2026-07-13); it cannot fix N× memory or the no-shared-cache problem.
- **React `<Activity>` for inactive panes** — interesting later for offscreen
  throttling (React 19.2 ships it; repo already on 19.2.5), but not needed:
  panes are all visible side by side.

## 5. Phases

### Phase 0 — infrastructure, zero behavior change (~½ session)
Registry (empty), PaneHost with iframe fallback, PaneNavProvider + the three
`useScreen*` hooks, error boundary. Extend `WorkspaceTab` with `path`/`search`
(backward-compatible parse of `smrtesy.tabs.v1`). Ship: everything still
renders via iframe; diff is inert plumbing. Full protocol + verify tabs UX
unchanged.

### Phase 1 — free screens (~½ session)
Register the zero-coupling screens: `/log`, `/crm`, `/vault`, `/plan`,
`/plan/team`, `/plan/repository`, `/whatsapp/autoreply`. No shim work needed.
Acceptance: pane opens instantly; state survives pane switching; closing the
last tab returns to the routed page; realtime/toasts still work; the same
screen full-page (mobile) is untouched.

### Phase 2 — the daily drivers (~1–2 sessions)
`/tasks` (swap TaskList's three hooks to `useScreen*`; keep `?focus` and the
strip-after-load replace against pane-local state; `smrtesy:badge-refresh`
now has exactly one listener), `/whatsapp` (+ ThreadView `?draft` via shim
instead of `history.replaceState`), `/sms`, `/voice` + `/voice/characters`
(VoiceNav active-tab from `useScreenPathname`, links via `PaneNav.push`),
`/bots`, `/reach`, `/knowledge` (detail routes open as sibling tabs or
in-pane push; unregistered details fall back to iframe automatically).
This phase realizes the shared-QueryClient payoff: the React Query desk cache
(added 2026-07-13) becomes cross-pane.

### Phase 3 — long tail + teardown (~1 session)
`/inbox`, `/projects`, `/settings`, `/admin`: move their server-side fetches
into the client components (or keep them iframe-backed permanently — decide
per screen; `/admin` is a fine iframe candidate). SettingsTabs: local tab
state instead of sibling-route `router.replace`. When no registry gaps remain
on the sidebar: delete `withEmbed`, `EmbedFlag`, the `data-embed` CSS block,
the postMessage bridge, `isEmbeddedPane()` call sites — and update CLAUDE.md:
new screens must register in the pane registry and use `useScreen*` hooks.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A migrated screen misbehaves in a pane | registry entry is one line — revert to iframe instantly |
| Same-screen-twice singleton collisions (realtime names) | tab dedupe already guarantees uniqueness; keep that invariant documented |
| Screen crash kills the whole workspace | per-pane error boundary with a reload-pane button |
| `?focus`/`?chat_id` deep links from notifications | entry points open tabs with `search` prefilled (openTab accepts full href already) |
| Old `smrtesy.tabs.v1` payloads after the WorkspaceTab change | parser defaults `path`/`search` from `href`; version-bump key only if shape breaks |
| Memory growth from many mounted panes | equal or better than today (iframes duplicate the whole app); revisit `<Activity>` if needed |
| Two app copies during transition (top window + legacy iframe panes) | identical to today's steady state; transition-only |

## 7. Success metrics

- Pane open (registered screen): < 100ms to first meaningful paint (vs
  0.5–1.5s today).
- One `tasks-realtime` channel and one Sidebar poll regardless of pane count.
- `?embed` layer fully deleted at the end of Phase 3.
