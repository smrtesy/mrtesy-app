"use client";

/**
 * Global search results screen — opened as a tab from the sidebar's search
 * split. Reads `q` from the URL, calls the backend hybrid search, and renders
 * the three groups (settings/pages · suggestions/tasks/info · Claude threads)
 * plus a synthesized answer for the content group, always above its sources so
 * the answer is verifiable.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Search, ExternalLink } from "lucide-react";
import { api } from "@/lib/api/client";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";

interface ResultItem {
  title: string;
  snippet: string | null;
  url: string;
  source_type: string;
  score: number;
}

interface SearchResponse {
  query: string;
  answer: string | null;
  groups: { settings: ResultItem[]; content: ResultItem[]; claude: ResultItem[] };
}

function ResultRow({ item, locale }: { item: ResultItem; locale: string }) {
  const t = useTranslations("searchPage");
  const isExternal = /^https?:\/\//i.test(item.url);

  const body = (
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium truncate">{item.title}</div>
      {item.snippet && (
        <div className="text-xs text-muted-foreground line-clamp-2">{item.snippet}</div>
      )}
    </div>
  );

  const cls =
    "block rounded-lg border px-3 py-2 hover:bg-accent hover:text-accent-foreground transition-colors";

  if (isExternal) {
    return (
      <a href={item.url} target="_blank" rel="noopener noreferrer" className={cls}>
        <div className="flex items-center gap-1.5">
          {body}
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("external")} />
        </div>
      </a>
    );
  }

  // Internal path → open as a sibling tab, locale-prefixed.
  return (
    <OpenTabLink href={`/${locale}${item.url}`} label={item.title} className={cls}>
      {body}
    </OpenTabLink>
  );
}

// Cap each group so a broad query (e.g. a common word like "סודות", which
// semantically matches many messages) doesn't flood the screen. Expand on click.
const GROUP_CAP = 8;

function Group({ titleKey, items, locale }: { titleKey: string; items: ResultItem[]; locale: string }) {
  const t = useTranslations("searchPage");
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, GROUP_CAP);
  const hidden = items.length - shown.length;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t(titleKey)} <span className="font-normal">({items.length})</span>
      </h2>
      <div className="space-y-1.5">
        {shown.map((item, i) => (
          <ResultRow key={`${item.source_type}-${item.url}-${i}`} item={item} locale={locale} />
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-primary hover:underline"
        >
          {t("showMore", { count: hidden })}
        </button>
      )}
    </section>
  );
}

export default function SearchResults() {
  const t = useTranslations("searchPage");
  const locale = useLocale();
  const searchParams = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!q) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q]);

  // Fully null-safe: a malformed/error response (no `groups`) must render as
  // empty, never crash the page.
  const settingsItems = data?.groups?.settings ?? [];
  const contentItems = data?.groups?.content ?? [];
  const claudeItems = data?.groups?.claude ?? [];
  const taskItems = contentItems.filter(
    (r) => r.source_type === "task" || r.source_type === "suggestion",
  );
  const infoItems = contentItems.filter((r) => r.source_type === "info");
  const total = settingsItems.length + contentItems.length + claudeItems.length;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 space-y-5">
      <div className="flex items-center gap-2">
        <Search className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {q && <span className="text-muted-foreground">— “{q}”</span>}
      </div>

      {loading && <div className="text-muted-foreground">{t("searching")}</div>}
      {error && <div className="text-status-late">{t("empty")}</div>}

      {!loading && !error && data && (
        <>
          {data.answer && (
            <div className="rounded-lg border bg-accent/40 p-3 space-y-1">
              <div className="text-xs font-semibold text-muted-foreground">{t("answerLabel")}</div>
              <div className="whitespace-pre-wrap">{data.answer}</div>
              <div className="text-xs text-muted-foreground">{t("answerHint")}</div>
            </div>
          )}

          {total === 0 ? (
            <div className="text-muted-foreground">
              <div>{t("empty")}</div>
              <div className="text-sm">{t("emptyHint")}</div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Order + split per the product spec: pages first, then tasks/
                  suggestions, then info sources, then Claude conversations. The
                  backend returns task+suggestion+info in one `content` group;
                  we split it here by source_type. */}
              <Group titleKey="groupSettings" items={settingsItems} locale={locale} />
              <Group titleKey="groupTasks" items={taskItems} locale={locale} />
              <Group titleKey="groupInfo" items={infoItems} locale={locale} />
              <Group titleKey="groupClaude" items={claudeItems} locale={locale} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
