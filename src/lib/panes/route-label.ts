/**
 * Human label for a top-level route that the tabs workspace has to adopt as a
 * pane (see TabsArea). Every pane needs a name for its close-button tooltip and
 * aria-label; sidebar-opened panes get theirs from the nav item that was
 * clicked, but a pane born from a browser navigation (a pasted deep link, an
 * OAuth return, the back button) has no click to take it from.
 *
 * The map is keyed by the LOCALE-STRIPPED path and matched by longest prefix,
 * so a deep route inherits its section's name — "/admin/apps/smrttask/secrets"
 * resolves through "/admin" to nav.platformAdmin. Anything with no known
 * section falls back to its last path segment.
 */

/** Locale-stripped path prefix → key in the "nav" i18n namespace. */
const NAV_LABEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["/inbox", "inboxIncoming"],
  ["/tasks", "tasks"],
  ["/suggestions", "suggestions"],
  ["/daily-report", "dailyReport"],
  ["/day-tools", "dayTools"],
  ["/account", "account"],
  ["/whatsapp", "whatsapp"],
  ["/whatsapp/autoreply", "whatsappAutoreply"],
  ["/sms", "sms"],
  ["/projects", "projects"],
  ["/knowledge", "knowledge"],
  ["/log", "log"],
  ["/calendar", "calendar"],
  ["/voice", "voiceProjects"],
  ["/voice/characters", "voiceCharacters"],
  ["/crm", "crm"],
  ["/reach", "reach"],
  ["/bots", "bots"],
  ["/plan", "planBoard"],
  ["/plan/my", "planMy"],
  ["/plan/team", "planTeam"],
  ["/plan/repository", "planRepository"],
  ["/plan/score", "planScore"],
  ["/vault", "vault"],
  ["/info", "info"],
  ["/studio", "studio"],
  ["/studio/models", "studioModels"],
  ["/studio/research", "studioResearch"],
  ["/claude", "claude"],
  ["/settings", "settings"],
  ["/transcription-experiment", "transcriptionExperiment"],
  ["/admin", "platformAdmin"],
];

import {
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Calendar,
  CalendarRange,
  CheckSquare,
  Clapperboard,
  FileText,
  FlaskConical,
  FolderOpen,
  Info,
  KeyRound,
  Layers,
  Lightbulb,
  MessageCircle,
  MessageSquare,
  Mic,
  Reply,
  ScrollText,
  Send,
  Settings,
  Shield,
  UserCircle,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Locale-stripped path prefix → the same lucide icon the sidebar renders for
 * that section. Kept alongside NAV_LABEL_KEYS (and matched the same way) so a
 * pane can show its section's icon on the collapsed rail. Longest-prefix wins,
 * so a deep route inherits its section's icon. Not every route needs an entry —
 * a path no prefix owns simply has no icon.
 */
const NAV_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["/inbox", Bell],
  ["/tasks", CheckSquare],
  ["/suggestions", Lightbulb],
  ["/daily-report", FileText],
  ["/day-tools", Wrench],
  ["/account", UserCircle],
  ["/whatsapp", MessageCircle],
  ["/whatsapp/autoreply", Reply],
  ["/sms", MessageSquare],
  ["/projects", FolderOpen],
  ["/knowledge", BookOpen],
  ["/log", ScrollText],
  ["/calendar", Calendar],
  ["/voice", Mic],
  ["/voice/characters", Users],
  ["/crm", Users],
  ["/reach", Send],
  ["/bots", MessageCircle],
  ["/plan", CalendarRange],
  ["/plan/my", CheckSquare],
  ["/plan/team", Users],
  ["/plan/repository", Archive],
  ["/plan/score", BarChart3],
  ["/vault", KeyRound],
  ["/info", Info],
  ["/studio", Clapperboard],
  ["/studio/models", Layers],
  ["/studio/research", FlaskConical],
  ["/claude", Bot],
  ["/settings", Settings],
  ["/transcription-experiment", FlaskConical],
  ["/admin", Shield],
];

/** The lucide icon for the deepest section that owns `path`, or null. */
export function navIconFor(path: string): LucideIcon | null {
  let best: LucideIcon | null = null;
  let bestLen = 0;
  for (const [prefix, icon] of NAV_ICONS) {
    const owns = path === prefix || path.startsWith(`${prefix}/`);
    if (owns && prefix.length > bestLen) {
      best = icon;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** The "nav" key for the deepest section that owns `path`, or null. */
export function navLabelKeyFor(path: string): string | null {
  let best: string | null = null;
  let bestLen = 0;
  for (const [prefix, key] of NAV_LABEL_KEYS) {
    const owns = path === prefix || path.startsWith(`${prefix}/`);
    if (owns && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Last resort when no nav section owns the path: its last segment. Every real
 *  screen is covered by the map above, so this is reached only by a route added
 *  without a nav entry — never by "/" itself, which has no pane. */
export function fallbackRouteLabel(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  return last ? last.replace(/[-_]/g, " ") : "smrtesy";
}
