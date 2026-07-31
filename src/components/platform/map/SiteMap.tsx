"use client";

/**
 * Site map — one screen listing every page of the platform the signed-in user
 * can open, grouped by app exactly like the sidebar.
 *
 * Every row is an `OpenTabLink`, so a click opens the page as a NEW pane beside
 * the map in the SAME app window (never a browser tab, never a swap of the map
 * itself). On mobile — where there is no tabs workspace — OpenTabLink degrades
 * to a plain link and navigates, which is the only thing that makes sense there.
 *
 * The catalog lives in `src/lib/site-map.ts`; the filtering comes from
 * `useAppAccess()` — the same three values the sidebar is built from — so an app
 * the user isn't entitled to, an admin-only screen, and the screens a "lite"
 * smrtTask worker can't use are hidden here exactly as they are there.
 *
 * The map deliberately lists MORE than the sidebar does: screens the sidebar
 * reaches indirectly (the guides behind an app name, /log, /calendar,
 * /daily-report, /day-tools, /settings/org, /account, the admin sub-pages) are
 * first-class rows here. That is the point of a map — a complete index — and
 * every one of them is still behind its own route gate.
 */

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Search, X, Map as MapIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SmrtName } from "@/components/icons/SmrtName";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { useAppAccess } from "@/contexts/AppAccessContext";
import { APPS } from "@/lib/apps/registry";
import { SITE_MAP, type SiteMapEntry, type SiteMapSection } from "@/lib/site-map";

/** A section resolved for this user: its visible entries + display strings. */
type ResolvedSection = {
  section: SiteMapSection;
  rows: Array<{ entry: SiteMapEntry; label: string; desc: string }>;
};

export function SiteMap() {
  const locale = useLocale();
  // Root namespace: the catalog carries FULL key paths ("nav.tasks",
  // "siteMap.desc.tasks"), so labels reuse the sidebar's own strings.
  const t = useTranslations();
  const tMap = useTranslations("siteMap");
  const { enabledApps, isAdmin, taskAccess } = useAppAccess();

  // Compact-UI rule: the filter is collapsed to an icon and only expands when
  // asked for (same pattern as the WhatsApp chat search).
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const sections = useMemo<ResolvedSection[]>(() => {
    // A lingering pre-absorption `smrtvoice` entitlement counts as smrtstudio,
    // the app it was absorbed into — same normalization as getLandingHref().
    const apps = new Set(enabledApps.map((s) => (s === "smrtvoice" ? "smrtstudio" : s)));
    const needle = query.trim().toLowerCase();

    const resolved: ResolvedSection[] = [];
    for (const section of SITE_MAP) {
      if (section.appSlug && !apps.has(section.appSlug)) continue;

      const rows = section.entries
        .filter((e) => !e.adminOnly || isAdmin)
        // Project-only ("lite") smrtTask worker: the sidebar collapses smrtTask
        // to the task list alone, so the map must not offer the rest either.
        .filter((e) => !(section.appSlug === "smrttask" && taskAccess === "lite" && !e.liteOk))
        .map((entry) => ({
          entry,
          label: t(entry.labelKey as Parameters<typeof t>[0]),
          desc: t(entry.descKey as Parameters<typeof t>[0]),
        }))
        .filter(
          (row) =>
            !needle ||
            row.label.toLowerCase().includes(needle) ||
            row.desc.toLowerCase().includes(needle) ||
            row.entry.path.toLowerCase().includes(needle),
        );

      if (rows.length > 0) resolved.push({ section, rows });
    }
    return resolved;
  }, [enabledApps, isAdmin, taskAccess, query, t]);

  const total = sections.reduce((n, s) => n + s.rows.length, 0);

  return (
    <div className="space-y-4">
      {/* pe-9 keeps the pane's floating grip (TabsWorkspace PaneControls) clear
          of the header row — same reservation InboxPane makes. */}
      <div className="flex items-center gap-2 pe-9">
        <MapIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{tMap("title")}</h1>
        <span className="text-xs text-muted-foreground">{tMap("count", { count: total })}</span>
        <button
          type="button"
          aria-label={tMap("filter")}
          title={tMap("filter")}
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((v) => !v);
            if (searchOpen) setQuery("");
          }}
          className="ms-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </button>
      </div>

      <p className="text-sm text-muted-foreground">{tMap("subtitle")}</p>

      {searchOpen && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchOpen(false);
              setQuery("");
            }
          }}
          placeholder={tMap("filterPlaceholder")}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      )}

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tMap("empty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sections.map(({ section, rows }) => (
            <SectionCard key={section.id} section={section} rows={rows} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionCard({
  section,
  rows,
  locale,
}: ResolvedSection & { locale: string }) {
  const t = useTranslations();
  const app = section.appSlug ? APPS[section.appSlug] : undefined;
  // Inline color so the arbitrary accent hex from the app registry survives
  // Tailwind's purge — same approach as AppNavGroup / AppSectionHeader.
  const accent = app?.color;

  return (
    <section
      className="rounded-xl border border-s-2 bg-card p-3"
      style={accent ? { borderInlineStartColor: accent } : undefined}
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        {app ? (
          // The registry's icons take only className, so the accent goes on a
          // wrapper and the svg inherits it via currentColor (same as
          // AppSectionHeader).
          <span
            className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wider"
            style={{ color: accent }}
          >
            <app.Icon className="h-4 w-4 shrink-0" />
            <span>
              <SmrtName word={app.word} />
            </span>
          </span>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t(section.titleKey as Parameters<typeof t>[0])}
          </span>
        )}
      </header>

      <ul className="space-y-0.5">
        {rows.map(({ entry, label, desc }) => (
          <li key={entry.path}>
            <OpenTabLink
              href={`/${locale}${entry.path}`}
              label={label}
              title={entry.path}
              className={cn(
                "group flex items-start gap-2 rounded-lg px-2 py-1.5",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <entry.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground line-clamp-2">
                  {desc}
                </span>
              </span>
            </OpenTabLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
