/**
 * Site map catalog — every screen of the platform a user can open directly,
 * grouped the way the sidebar groups them (one section per app, then the
 * cross-app platform section, then admin).
 *
 * Rendered by `src/components/platform/map/SiteMap.tsx` at `/map`.
 *
 * Rules for this file:
 *  - **Static catalog = linkable SCREENS only.** A dynamic route
 *    (`/projects/[id]`, `/voice/scripts/[id]`, `/admin/users/[id]`,
 *    `/bots/[botId]/…`) has no fixed id, so the generic screen is not a static
 *    entry here. Redirect-only routes are skipped too — `/suggestions`
 *    redirects to `/inbox`, so listing both would put the same screen on the
 *    map twice.
 *  - **Live instances ARE surfaced, just not from this file.** The renderer
 *    (`SiteMap.tsx` → `StudioSubpages`) fetches the real smrtStudio projects
 *    and characters at runtime and lists them as deep links under the studio
 *    card. So "a specific project/character" IS on the map; it just comes from
 *    the API, not from this static catalog. Add a new dynamic instance list
 *    there, not here.
 *  - `path` is locale-less (the renderer prepends `/{locale}`), matching the
 *    hrefs in the sidebar and in `route-label.ts`.
 *  - `labelKey` / `descKey` are FULL i18n key paths (root namespace), so
 *    labels can reuse the existing `nav.*` strings instead of duplicating
 *    them; descriptions live under `siteMap.desc.*`.
 *  - Adding or removing a screen means editing this file in the same commit,
 *    like `docs/codebase-map.md`. The search index has a twin curated list
 *    (`server/src/modules/platform/search/destinations.ts`) — when you add a
 *    screen worth finding by search, add it there too.
 */

import {
  Archive,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CalendarRange,
  CheckSquare,
  Clapperboard,
  Coins,
  FileText,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  KeyRound,
  Layers,
  LayoutDashboard,
  Library,
  LineChart,
  MessageCircle,
  MessageSquare,
  Mic,
  Reply,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  ScanSearch,
  Sliders,
  UserCircle,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface SiteMapEntry {
  /** Locale-less, app-relative path, e.g. "/plan/team". */
  path: string;
  /** Full i18n key for the screen name, e.g. "nav.tasks". */
  labelKey: string;
  /** Full i18n key for the one-line "what is this screen" description. */
  descKey: string;
  icon: LucideIcon;
  /** Rendered only for a super-admin (the route's own gate). */
  adminOnly?: boolean;
  /**
   * Rendered only for an org owner/admin. `/settings/org` renders its body
   * behind `canManageOrg` (SettingsTabs.tsx), so a plain member who follows the
   * link gets the settings heading and an empty panel.
   */
  orgManagerOnly?: boolean;
  /**
   * Kept for a "lite" (project-only) smrtTask worker. Everything else in the
   * smrtTask section is hidden from them, mirroring the sidebar — see
   * `visibleSmrtTaskItems` in Sidebar.tsx.
   */
  liteOk?: boolean;
}

export interface SiteMapSection {
  /** Stable key (also the React key). */
  id: string;
  /**
   * App slug when this section IS an app: gates the whole section on the
   * entitlement and gives the header its icon, accent color and smrt-name.
   */
  appSlug?: string;
  /** Full i18n key for a non-app section's title. */
  titleKey?: string;
  entries: SiteMapEntry[];
}

export const SITE_MAP: SiteMapSection[] = [
  {
    id: "smrttask",
    appSlug: "smrttask",
    entries: [
      { path: "/tasks",     labelKey: "nav.tasks",     descKey: "siteMap.desc.tasks",     icon: CheckSquare,   liteOk: true },
      { path: "/whatsapp",  labelKey: "nav.whatsapp",  descKey: "siteMap.desc.whatsapp",  icon: MessageCircle },
      { path: "/whatsapp/autoreply", labelKey: "nav.whatsappAutoreply", descKey: "siteMap.desc.whatsappAutoreply", icon: Reply },
      { path: "/sms",       labelKey: "nav.sms",       descKey: "siteMap.desc.sms",       icon: MessageSquare },
      { path: "/projects",  labelKey: "nav.projects",  descKey: "siteMap.desc.projects",  icon: FolderOpen },
      { path: "/knowledge", labelKey: "nav.knowledge", descKey: "siteMap.desc.knowledge", icon: BookOpen },
      { path: "/daily-report", labelKey: "nav.dailyReport", descKey: "siteMap.desc.dailyReport", icon: FileText },
      { path: "/day-tools", labelKey: "nav.dayTools",  descKey: "siteMap.desc.dayTools",  icon: Wrench },
      { path: "/log",       labelKey: "nav.log",       descKey: "siteMap.desc.log",       icon: ScrollText },
      { path: "/transcription-experiment", labelKey: "nav.transcriptionExperiment", descKey: "siteMap.desc.transcriptionExperiment", icon: FlaskConical },
      { path: "/tasks/guide", labelKey: "siteMap.page.guideSmrttask", descKey: "siteMap.desc.guide", icon: BookOpen },
    ],
  },
  {
    id: "smrtplan",
    appSlug: "smrtplan",
    entries: [
      { path: "/plan",            labelKey: "nav.planBoard",      descKey: "siteMap.desc.planBoard",      icon: CalendarRange },
      { path: "/plan/team",       labelKey: "nav.planTeam",       descKey: "siteMap.desc.planTeam",       icon: Users },
      { path: "/plan/repository", labelKey: "nav.planRepository", descKey: "siteMap.desc.planRepository", icon: Archive },
      { path: "/plan/guide",      labelKey: "siteMap.page.guideSmrtplan", descKey: "siteMap.desc.guide",   icon: BookOpen },
    ],
  },
  {
    id: "smrtstudio",
    appSlug: "smrtstudio",
    entries: [
      { path: "/studio",           labelKey: "nav.studio",           descKey: "siteMap.desc.studio",           icon: Clapperboard },
      { path: "/studio/projects",  labelKey: "nav.studioProduction", descKey: "siteMap.desc.studioProduction", icon: Layers },
      { path: "/studio/models",    labelKey: "nav.studioModels",     descKey: "siteMap.desc.studioModels",     icon: Boxes },
      { path: "/studio/research",  labelKey: "nav.studioResearch",   descKey: "siteMap.desc.studioResearch",   icon: FlaskConical },
      { path: "/voice/library",    labelKey: "siteMap.page.voiceLibrary",  descKey: "siteMap.desc.voiceLibrary",  icon: Library },
      { path: "/voice/characters", labelKey: "nav.voiceCharacters",  descKey: "siteMap.desc.voiceCharacters",  icon: Users },
      { path: "/voice/projects/new", labelKey: "siteMap.page.voiceProjectNew", descKey: "siteMap.desc.voiceProjectNew", icon: FilePlus2 },
      { path: "/voice/insights",   labelKey: "siteMap.page.voiceInsights", descKey: "siteMap.desc.voiceInsights", icon: LineChart },
      // The real screen: /voice/settings is only a redirect here.
      { path: "/settings/apps/smrtstudio", labelKey: "nav.voiceSettings", descKey: "siteMap.desc.voiceSettings", icon: Sliders },
      { path: "/voice/guide",      labelKey: "nav.voiceGuide",       descKey: "siteMap.desc.voiceGuide",       icon: Mic },
    ],
  },
  {
    id: "smrtcrm",
    appSlug: "smrtcrm",
    entries: [
      { path: "/crm",       labelKey: "nav.crm",   descKey: "siteMap.desc.crm",   icon: Users },
      { path: "/crm/guide", labelKey: "siteMap.page.guideSmrtcrm", descKey: "siteMap.desc.guide", icon: BookOpen },
    ],
  },
  {
    id: "smrtreach",
    appSlug: "smrtreach",
    entries: [
      { path: "/reach",          labelKey: "nav.reach",                  descKey: "siteMap.desc.reach",         icon: Send },
      { path: "/reach/settings", labelKey: "siteMap.page.reachSettings", descKey: "siteMap.desc.reachSettings", icon: Settings },
      { path: "/reach/guide",    labelKey: "siteMap.page.guideSmrtreach", descKey: "siteMap.desc.guide",        icon: BookOpen },
    ],
  },
  {
    id: "smrtbot",
    appSlug: "smrtbot",
    entries: [
      { path: "/bots",       labelKey: "nav.bots",  descKey: "siteMap.desc.bots",  icon: Bot },
      { path: "/bots/guide", labelKey: "siteMap.page.guideSmrtbot", descKey: "siteMap.desc.guide", icon: BookOpen },
    ],
  },
  {
    id: "smrtvault",
    appSlug: "smrtvault",
    entries: [
      { path: "/vault", labelKey: "nav.vault", descKey: "siteMap.desc.vault", icon: KeyRound },
    ],
  },
  {
    id: "smrtinfo",
    appSlug: "smrtinfo",
    entries: [
      { path: "/info", labelKey: "nav.info", descKey: "siteMap.desc.info", icon: Info },
    ],
  },
  {
    id: "platform",
    titleKey: "nav.sectionPlatform",
    entries: [
      // /inbox lives here, not under smrtTask: it is the cross-app notification
      // screen (route group `(platform)`), and the sidebar also shows it to a
      // user WITHOUT smrtTask. Its smrtTask tabs are entitlement-gated inside
      // the screen itself (InboxPane / the routed page).
      { path: "/inbox",             labelKey: "nav.inboxIncoming",             descKey: "siteMap.desc.inbox",            icon: Bell },
      { path: "/claude",            labelKey: "nav.claude",                    descKey: "siteMap.desc.claude",           icon: Bot, adminOnly: true },
      { path: "/search",            labelKey: "nav.search",                    descKey: "siteMap.desc.search",           icon: Search },
      { path: "/settings",          labelKey: "nav.settings",                  descKey: "siteMap.desc.settings",         icon: Settings },
      { path: "/settings/org",      labelKey: "siteMap.page.settingsOrg",      descKey: "siteMap.desc.settingsOrg",      icon: Building2, orgManagerOnly: true },
      { path: "/settings/platform", labelKey: "siteMap.page.settingsPlatform", descKey: "siteMap.desc.settingsPlatform", icon: Shield, adminOnly: true },
      { path: "/account",           labelKey: "nav.account",                   descKey: "siteMap.desc.account",          icon: UserCircle },
    ],
  },
  {
    id: "admin",
    titleKey: "nav.platformAdmin",
    entries: [
      { path: "/admin",                labelKey: "adminNav.dashboard",    descKey: "siteMap.desc.adminDashboard",    icon: LayoutDashboard, adminOnly: true },
      { path: "/admin/apps",           labelKey: "adminNav.apps",         descKey: "siteMap.desc.adminApps",         icon: Boxes,      adminOnly: true },
      { path: "/admin/users",          labelKey: "adminNav.users",        descKey: "siteMap.desc.adminUsers",        icon: Users,      adminOnly: true },
      { path: "/admin/orgs",           labelKey: "adminNav.orgs",         descKey: "siteMap.desc.adminOrgs",         icon: Building2,  adminOnly: true },
      { path: "/admin/super-admins",   labelKey: "adminNav.superAdmins",  descKey: "siteMap.desc.adminSuperAdmins",  icon: Shield,     adminOnly: true },
      { path: "/admin/logs",           labelKey: "adminNav.logs",         descKey: "siteMap.desc.adminLogs",         icon: ScrollText, adminOnly: true },
      { path: "/admin/usage",          labelKey: "adminNav.usage",        descKey: "siteMap.desc.adminUsage",        icon: Coins,      adminOnly: true },
      { path: "/admin/claude",         labelKey: "adminNav.claude",       descKey: "siteMap.desc.adminClaude",       icon: Gauge,      adminOnly: true },
      { path: "/admin/docs",           labelKey: "adminNav.docs",         descKey: "siteMap.desc.adminDocs",         icon: FileText,   adminOnly: true },
      { path: "/admin/domain-tracker", labelKey: "adminNav.domainTracker", descKey: "siteMap.desc.adminDomainTracker", icon: Globe,    adminOnly: true },
      { path: "/admin/price-tracker",  labelKey: "adminNav.priceTracker", descKey: "siteMap.desc.adminPriceTracker", icon: ScanSearch, adminOnly: true },
    ],
  },
];
