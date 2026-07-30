/**
 * Navigation destinations — the finite, curated set of screens / settings /
 * admin pages that the global search can send you to (source_type =
 * 'destination').
 *
 * Each entry is bilingual (Hebrew + English title) and carries free-form
 * `keywords` (synonyms in both languages) so the hybrid search matches a
 * concept the label itself doesn't spell out — e.g. "סודות/טוקנים/keys" →
 * the Keys & Secrets page. Titles double as the label shown in results.
 *
 * `path` is locale-less and app-relative (starts with "/"); the frontend
 * prepends the locale basePath when it opens the result as a tab.
 *
 * `adminOnly` entries are indexed once but filtered out of results for a
 * non-super-admin caller (the endpoint checks isSuperAdmin).
 *
 * This is the v1 source of truth for destinations. Deriving it from the nav
 * registry + i18n and enforcing freshness with a push guard (like map-guard.sh)
 * is a documented follow-up in docs/global-search-plan.md.
 */

export interface Destination {
  path: string;
  titleHe: string;
  titleEn: string;
  keywords: string;
  adminOnly?: boolean;
}

export const DESTINATIONS: Destination[] = [
  // ── Core smrtTask screens ──────────────────────────────────────────────
  { path: "/tasks", titleHe: "משימות", titleEn: "Tasks", keywords: "משימות מטלות tasks todo to-do inbox" },
  { path: "/calendar", titleHe: "יומן", titleEn: "Calendar", keywords: "יומן לוח שנה אירועים calendar events schedule" },
  { path: "/projects", titleHe: "פרויקטים", titleEn: "Projects", keywords: "פרויקטים projects" },
  { path: "/whatsapp", titleHe: "וואטסאפ", titleEn: "WhatsApp", keywords: "וואטסאפ ווצאפ הודעות whatsapp chats messages" },
  { path: "/sms", titleHe: "SMS", titleEn: "SMS", keywords: "סמס הודעות טקסט sms text messages" },
  { path: "/log", titleHe: "יומן פעילות", titleEn: "Activity Log", keywords: "לוג יומן פעילות היסטוריה log activity history" },
  { path: "/daily-report", titleHe: "דוח יומי", titleEn: "Daily Report", keywords: "דוח יומי סיכום daily report summary" },
  { path: "/day-tools", titleHe: "כלי היום", titleEn: "Day Tools", keywords: "כלים יום day tools" },
  { path: "/knowledge", titleHe: "מאגר ידע", titleEn: "Knowledge", keywords: "ידע מאגר knowledge base answers" },

  // ── Other apps ─────────────────────────────────────────────────────────
  { path: "/voice", titleHe: "smrtVoice — קול ותמלול", titleEn: "smrtVoice", keywords: "קול תמלול הקלטות voice transcription audio" },
  { path: "/crm", titleHe: "smrtCRM — לקוחות", titleEn: "smrtCRM", keywords: "crm לקוחות אנשי קשר contacts customers" },
  { path: "/reach", titleHe: "smrtReach — קמפיינים", titleEn: "smrtReach", keywords: "reach קמפיינים דיוור outreach campaigns" },
  { path: "/bots", titleHe: "smrtBot — בוטים", titleEn: "smrtBot", keywords: "בוטים bot bots chatbot" },
  { path: "/plan", titleHe: "smrtPlan — תכנון", titleEn: "smrtPlan", keywords: "תכנון plan planning" },
  { path: "/vault", titleHe: "smrtVault — כספת", titleEn: "smrtVault", keywords: "כספת vault" },
  { path: "/info", titleHe: "smrtInfo — מרכז מידע", titleEn: "smrtInfo", keywords: "מידע עובדות info facts information center" },
  { path: "/studio", titleHe: "smrtStudio", titleEn: "smrtStudio", keywords: "סטודיו תוכן studio content" },
  { path: "/claude", titleHe: "קלוד", titleEn: "Claude", keywords: "קלוד claude console chat agent" },

  // ── Platform / cross-app ───────────────────────────────────────────────
  { path: "/inbox", titleHe: "התראות", titleEn: "Inbox", keywords: "התראות נוטיפיקציות inbox notifications" },
  { path: "/suggestions", titleHe: "הצעות", titleEn: "Suggestions", keywords: "הצעות suggestions" },
  { path: "/settings", titleHe: "הגדרות", titleEn: "Settings", keywords: "הגדרות settings preferences config תצורה" },
  { path: "/settings/org", titleHe: "הגדרות ארגון", titleEn: "Org Settings", keywords: "ארגון organization org settings team" },
  { path: "/account", titleHe: "החשבון שלי", titleEn: "My Account", keywords: "חשבון פרופיל account profile me" },

  // ── Admin (super-admin only) ───────────────────────────────────────────
  { path: "/admin", titleHe: "ניהול פלטפורמה", titleEn: "Platform Admin", keywords: "אדמין ניהול פלטפורמה admin", adminOnly: true },
  { path: "/admin/apps", titleHe: "אפליקציות", titleEn: "Apps", keywords: "אפליקציות apps admin", adminOnly: true },
  { path: "/admin/users", titleHe: "משתמשים", titleEn: "Users", keywords: "משתמשים users accounts admin", adminOnly: true },
  { path: "/admin/orgs", titleHe: "ארגונים", titleEn: "Organizations", keywords: "ארגונים organizations orgs admin", adminOnly: true },
  { path: "/admin/logs", titleHe: "לוגים", titleEn: "Logs", keywords: "לוגים שגיאות logs errors admin", adminOnly: true },
  { path: "/admin/usage", titleHe: "צריכה ועלויות", titleEn: "Usage & Cost", keywords: "צריכה עלות טוקנים usage cost tokens billing admin", adminOnly: true },
  { path: "/admin/apps/smrttask/secrets", titleHe: "מפתחות וסודות", titleEn: "Keys & Secrets", keywords: "סודות מפתחות טוקנים סיסמאות מוצפן vault secrets keys tokens passwords credentials api key encrypted", adminOnly: true },
  { path: "/admin/apps/smrttask/prompts", titleHe: "פרומפטים", titleEn: "Prompts", keywords: "פרומפטים prompts ai admin", adminOnly: true },
  { path: "/admin/apps/smrttask/parameters", titleHe: "פרמטרים", titleEn: "Parameters", keywords: "פרמטרים הגדרות parameters config admin", adminOnly: true },
  { path: "/admin/apps/smrttask/services", titleHe: "שירותים ואינטגרציות", titleEn: "Services", keywords: "שירותים אינטגרציות google gmail drive services integrations admin", adminOnly: true },
];
