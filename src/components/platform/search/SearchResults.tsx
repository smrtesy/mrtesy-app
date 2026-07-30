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
    <>
      <div className="font-medium truncate">{item.title}</div>
      {item.snippet && (
        <div className="text-sm text-muted-foreground line-clamp-2">{item.snippet}</div>
      )}
    </>
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

function Group({ titleKey, items, locale }: { titleKey: string; items: ResultItem[]; locale: string }) {
  const t = useTranslations("searchPage");
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{t(titleKey)}</h2>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <ResultRow key={`${item.source_type}-${item.url}-${i}`} item={item} locale={locale} />
        ))}
      </div>
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
    api<SearchResponse>(`/search?q=${encodeURIComponent(q)}`)
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

  const total =
    (data?.groups.settings.length ?? 0) +
    (data?.groups.content.length ?? 0) +
    (data?.groups.claude.length ?? 0);

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
              <Group titleKey="groupContent" items={data.groups.content} locale={locale} />
              <Group titleKey="groupSettings" items={data.groups.settings} locale={locale} />
              <Group titleKey="groupClaude" items={data.groups.claude} locale={locale} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
