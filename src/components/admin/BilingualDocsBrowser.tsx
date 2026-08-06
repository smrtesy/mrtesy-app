"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertCircle, Check, Code2, Download, FileText, Languages, Link2, Loader2, RefreshCw,
} from "lucide-react";
import { Markdown, type MarkdownLinkComponent } from "@/components/common/Markdown";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Lang = "he" | "en";
const LANGS: Lang[] = ["he", "en"];

export interface LangSlot {
  lang: Lang;
  title: string;
  content: string | null;
  source: "repo" | "translation";
  status?: "pending" | "running" | "ready" | "error";
  error?: string | null;
  sourcePath?: string;
  sourceHash?: string | null;
  /** A translation whose source file changed since it was produced. */
  staleSource?: boolean;
  created?: string | null;
  updated?: string | null;
}

export interface LogicalDoc {
  docKey: string;
  mixed?: boolean;
  slots: { he: LangSlot | null; en: LangSlot | null };
  /** The repo file (existing language) a missing slot is translated FROM. */
  source: { path: string; lang: Lang; title: string; content: string; sourceHash: string };
}

/** New York, per CLAUDE.md — never the viewer's local zone, never raw UTC. */
function fmt(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(locale === "he" ? "he-IL" : "en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface TranslationRow {
  doc_key: string;
  target_lang: string;
  title: string | null;
  content: string | null;
  status: string;
  error: string | null;
  source_hash: string | null;
}

/** Live overrides for translation slots, seeded from props, updated by polling. */
type Runtime = Record<string, {
  status: LangSlot["status"];
  content: string | null;
  title: string | null;
  error?: string | null;
  staleSource?: boolean;
}>;

const rtKey = (docKey: string, lang: Lang) => `${docKey}|${lang}`;

export function BilingualDocsBrowser({ docs }: { docs: LogicalDoc[] }) {
  const t = useTranslations("admin");
  const locale = useLocale();

  const docByKey = useMemo(() => {
    const m = new Map<string, LogicalDoc>();
    for (const d of docs) m.set(d.docKey, d);
    return m;
  }, [docs]);
  const docKeys = useMemo(() => new Set(docs.map((d) => d.docKey)), [docs]);

  const [runtime, setRuntime] = useState<Runtime>(() => {
    const seed: Runtime = {};
    for (const d of docs) {
      for (const lang of LANGS) {
        const slot = d.slots[lang];
        if (slot && slot.source === "translation") {
          seed[rtKey(d.docKey, lang)] = {
            status: slot.status ?? "ready",
            content: slot.content,
            title: slot.title,
            error: slot.error,
            staleSource: slot.staleSource,
          };
        }
      }
    }
    return seed;
  });

  /** Effective slot: repo slots are static; translation slots read runtime. */
  const effectiveSlot = useCallback(
    (docKey: string, lang: Lang): LangSlot | null => {
      const doc = docByKey.get(docKey);
      if (!doc) return null;
      const base = doc.slots[lang];
      if (base && base.source === "repo") return base;
      const rt = runtime[rtKey(docKey, lang)];
      if (!rt) return null; // no repo file and no translation yet → empty
      return {
        lang,
        title: rt.title ?? doc.source.title,
        content: rt.content,
        source: "translation",
        status: rt.status,
        error: rt.error,
        staleSource: rt.staleSource,
      };
    },
    [docByKey, runtime],
  );

  // ── active document (deep-linked via ?doc=&lang=) ────────────────────────
  const [active, setActive] = useState<{ docKey: string; lang: Lang } | null>(null);

  const openDoc = useCallback((docKey: string, preferLang: Lang) => {
    const doc = docByKey.get(docKey);
    if (!doc) return;
    // Prefer the asked language; fall back to whichever version exists.
    const other: Lang = preferLang === "he" ? "en" : "he";
    const lang: Lang = doc.slots[preferLang] || runtime[rtKey(docKey, preferLang)]
      ? preferLang
      : other;
    setActive({ docKey, lang });
    if (typeof window !== "undefined") {
      const url = `${window.location.pathname}?doc=${encodeURIComponent(docKey)}&lang=${lang}`;
      window.history.replaceState(null, "", url);
    }
  }, [docByKey, runtime]);

  // Initialise from the URL once, else the first document.
  useEffect(() => {
    if (active || docs.length === 0) return;
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    const wantKey = params.get("doc");
    const wantLang = params.get("lang");
    if (wantKey && docByKey.has(wantKey)) {
      openDoc(wantKey, wantLang === "en" ? "en" : "he");
      return;
    }
    const first = docs[0];
    setActive({ docKey: first.docKey, lang: first.slots.he ? "he" : "en" });
  }, [active, docs, docByKey, openDoc]);

  // ── translation ──────────────────────────────────────────────────────────
  async function translate(doc: LogicalDoc, target: Lang) {
    const key = rtKey(doc.docKey, target);
    setRuntime((r) => ({ ...r, [key]: { status: "running", content: null, title: null } }));
    try {
      await api("/api/admin/docs/translate", {
        method: "POST",
        body: {
          doc_key: doc.docKey,
          source_path: doc.source.path,
          target_lang: target,
          source_content: doc.source.content,
          source_title: doc.source.title,
        },
      });
    } catch {
      setRuntime((r) => ({
        ...r,
        [key]: { status: "error", content: null, title: null, error: t("docsTranslationError") },
      }));
    }
  }

  // Poll while anything is translating; merge every row back into runtime.
  const hasRunning = Object.values(runtime).some((r) => r.status === "running");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!hasRunning) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { translations } = await api<{ translations: TranslationRow[] }>(
          "/api/admin/docs/translations",
        );
        if (cancelled) return;
        setRuntime((prev) => {
          const next = { ...prev };
          for (const row of translations) {
            if (row.target_lang !== "he" && row.target_lang !== "en") continue;
            const doc = docByKey.get(row.doc_key);
            if (!doc) continue;
            const currentHash = doc.source.sourceHash;
            next[rtKey(row.doc_key, row.target_lang as Lang)] = {
              status: row.status as LangSlot["status"],
              content: row.content,
              title: row.title,
              error: row.error,
              staleSource:
                row.status === "ready" && !!row.source_hash && row.source_hash !== currentHash,
            };
          }
          return next;
        });
      } catch { /* transient — the next tick retries */ }
    };
    pollRef.current = setInterval(tick, 4000);
    void tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasRunning, docByKey]);

  // ── reading pane state ─────────────────────────────────────────────────────
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeDoc = active ? docByKey.get(active.docKey) : null;
  const activeSlot = active ? effectiveSlot(active.docKey, active.lang) : null;

  // In-app cross-links: relative doc links resolve against a sentinel base, then
  // this renderer routes docs we have to the tab and everything else to GitHub.
  const linkBaseFor = (slot: LangSlot | null, doc: LogicalDoc | null): string | undefined => {
    const path = slot?.sourcePath ?? doc?.source.path;
    if (!path) return undefined;
    const dir = path.split("/").slice(0, -1).join("/"); // docs/sub
    return `https://docs.internal/${dir}/`;
  };
  const linkComponent: MarkdownLinkComponent = useCallback(
    ({ href, className, children }) => {
      const SENT = "https://docs.internal/";
      if (href.startsWith(SENT)) {
        const repoRel = href.slice(SENT.length);
        const [p, hash] = repoRel.split("#");
        if (p.startsWith("docs/") && p.endsWith(".md")) {
          const key = p.replace(/^docs\//, "").replace(/\.md$/, "").replace(/\.(he|en)$/, "");
          if (docKeys.has(key)) {
            const lang = active?.lang ?? "he";
            // Keep the #anchor in the href so a copied / middle-clicked link is
            // not lossy; an in-tab click jumps to the doc and, if present, scrolls.
            const inAppHref = `?doc=${encodeURIComponent(key)}&lang=${lang}${hash ? `#${hash}` : ""}`;
            return (
              <a
                href={inAppHref}
                className={className}
                onClick={(e) => {
                  e.preventDefault();
                  openDoc(key, lang);
                  if (hash && typeof window !== "undefined") {
                    // Best-effort scroll once the target doc has rendered.
                    setTimeout(() => {
                      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth" });
                    }, 100);
                  }
                }}
              >
                {children}
              </a>
            );
          }
        }
        const gh = `https://github.com/smrtesy/mrtesy-app/blob/main/${p}${hash ? `#${hash}` : ""}`;
        return <a href={gh} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
    },
    [docKeys, active, openDoc],
  );

  function handleDownload() {
    if (!activeSlot?.content) return;
    const blob = new Blob([activeSlot.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active!.docKey.split("/").pop()}.${active!.lang}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyLink() {
    if (!active || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}?doc=${encodeURIComponent(active.docKey)}&lang=${active.lang}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("docsEmpty")}</p>;
  }

  const langLabel = (lang: Lang) => (lang === "he" ? t("docsLangHe") : t("docsLangEn"));

  // ── a single language cell in the two-column list ──────────────────────────
  function Cell({ doc, lang }: { doc: LogicalDoc; lang: Lang }) {
    const slot = effectiveSlot(doc.docKey, lang);
    const isActive = active?.docKey === doc.docKey && active.lang === lang;

    if (slot && (slot.source === "repo" || slot.status === "ready")) {
      return (
        <button
          onClick={() => openDoc(doc.docKey, lang)}
          title={doc.source.path}
          dir={lang === "he" ? "rtl" : "ltr"}
          className={cn(
            "w-full text-start rounded-md px-2.5 py-1.5 text-xs transition-colors truncate",
            isActive ? "bg-primary text-primary-foreground" : "hover:bg-accent",
          )}
        >
          <span className="truncate">{slot.title}</span>
          {slot.source === "translation" && (
            <span className={cn("ms-1 text-[10px]", isActive ? "opacity-80" : "opacity-50")}>
              · {t("docsAutoTranslated")}
            </span>
          )}
          {slot.staleSource && (
            <span className="ms-1 text-[10px] text-amber-600">· {t("docsSourceUpdatedRetranslate")}</span>
          )}
        </button>
      );
    }
    if (slot && slot.status === "running") {
      return (
        <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("docsTranslating")}
        </span>
      );
    }
    // empty, or errored → offer translate/retry
    const errored = slot?.status === "error";
    return (
      <button
        onClick={() => translate(doc, lang)}
        title={errored ? slot?.error ?? "" : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
          errored ? "text-red-600 hover:bg-red-50" : "text-muted-foreground hover:bg-accent",
        )}
      >
        {errored ? <AlertCircle className="h-3.5 w-3.5" /> : <Languages className="h-3.5 w-3.5" />}
        {errored ? t("docsTranslationError") : t("docsTranslate")}
      </button>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
      {/* two-column list, one column per language */}
      <div className="space-y-1">
        <div className="grid grid-cols-2 gap-2 px-2.5 pb-1 text-[11px] font-semibold text-muted-foreground">
          <span dir="rtl">{t("docsLangHe")}</span>
          <span dir="ltr" className="text-start">{t("docsLangEn")}</span>
        </div>
        <div className="max-h-[75vh] overflow-auto pe-1">
          {docs.map((d) => (
            <div key={d.docKey} className="grid grid-cols-2 gap-2 border-b border-border/40 py-0.5">
              <Cell doc={d} lang="he" />
              <Cell doc={d} lang="en" />
            </div>
          ))}
        </div>
      </div>

      {/* reading pane */}
      <div className="min-w-0 space-y-2">
        {activeSlot ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <code className="block text-xs text-muted-foreground truncate">
                  {activeDoc?.source.path} · {langLabel(active!.lang)}
                </code>
                {fmt(activeSlot.updated, locale) && (
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    {t("docsUpdated")}: {fmt(activeSlot.updated, locale)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {activeSlot.source === "translation" && activeSlot.staleSource && activeDoc && (
                  <Button
                    variant="outline" size="sm"
                    onClick={() => translate(activeDoc, active!.lang)}
                    className="gap-1.5 text-amber-600"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("docsRetranslate")}
                  </Button>
                )}
                <IconButton
                  label={copied ? t("docsCopied") : t("docsCopyLink")}
                  color="primary"
                  onClick={copyLink}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                </IconButton>
                <IconButton
                  label={raw ? t("docsRendered") : t("docsSource")}
                  color="primary"
                  onClick={() => setRaw((v) => !v)}
                >
                  {raw ? <FileText className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
                </IconButton>
                <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  {t("docsDownload")}
                </Button>
              </div>
            </div>

            {activeSlot.status === "running" ? (
              <div className="flex items-center gap-2 rounded-lg border bg-card p-5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("docsTranslating")}
              </div>
            ) : activeSlot.status === "error" ? (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
                <AlertCircle className="h-4 w-4" /> {activeSlot.error ?? t("docsTranslationError")}
              </div>
            ) : raw ? (
              <pre
                dir="ltr"
                className="rounded-lg border bg-muted/40 p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[75vh] whitespace-pre-wrap break-words text-start"
              >
                {activeSlot.content}
              </pre>
            ) : (
              <div className="rounded-lg border bg-card p-5 overflow-auto max-h-[75vh]">
                <Markdown
                  linkBase={linkBaseFor(activeSlot, activeDoc ?? null)}
                  linkComponent={linkComponent}
                >
                  {activeSlot.content ?? ""}
                </Markdown>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
