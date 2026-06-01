"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface SourceMessageContent {
  id: string;
  source_type: string | null;
  source_url: string | null;
  serial_display: string | null;
  sender: string | null;
  sender_email: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
}

// Render plain-text body, turning bare URLs into clickable links. A link the
// sender included should land the user on the exact page (the product's
// "preserve deep links verbatim" rule) rather than sitting there as dead text.
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline break-all"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

// Gmail stores the body as-is; when an email has no text/plain part the
// collector keeps the raw HTML. We render that in a sandboxed iframe (no
// allow-scripts → inert, so no XSS; allow-popups + <base target=_blank> so the
// sender's links still open) — but ONLY when there's real, renderable content.
// Some senders' stored bodies are almost entirely a giant stylesheet (with the
// visible content truncated off by the collector's size cap), so a naive iframe
// would just dump CSS as text. We strip the boilerplate first and decide.

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
}

// True only when, after dropping <style>/<script>/<head>, there's an actual
// content-bearing HTML tag left to render. A body that is just a DOCTYPE +
// naked CSS rules returns false and falls back to text/empty.
function hasRenderableHtml(html: string): boolean {
  return /<(body|table|div|p|a|img|ul|ol|h[1-6]|tr|td|span|br)[\s>/]/i.test(stripNonContent(html));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// Best-effort plain-text extraction: drop style/script/head, strip naked CSS
// rule blocks (only when the body actually contains `{…}`), turn block tags
// into line breaks, then strip remaining tags and decode entities. Plain-text
// emails (no braces, no tags) pass through essentially untouched.
function extractReadableText(raw: string): string {
  let s = stripNonContent(raw);
  if (s.includes("{") && s.includes("}")) {
    s = s.replace(/@media[^{]*\{(?:[^{}]+|\{[^{}]*\})*\}/gi, " ");
    s = s.replace(/[^{}<>;]+\{[^{}]*\}/g, " ");
  }
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function withBaseTarget(html: string): string {
  return `<base target="_blank"><meta charset="utf-8">${html}`;
}

/**
 * In-app reader for a Gmail source message. Opened from SourceLink on mobile,
 * where Gmail can't deep-link to a specific message (it lands on the inbox).
 * Shows the email's stored content and offers an "open in Gmail" escape hatch.
 */
export function SourceMessageReader({
  sourceMessageId,
  open,
  onClose,
}: {
  sourceMessageId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("emailReader");
  const { locale } = useParams<{ locale: string }>();
  const [data, setData] = useState<SourceMessageContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(320);

  useEffect(() => {
    if (!open || !sourceMessageId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    api<{ source: SourceMessageContent }>(`/api/source-messages/${sourceMessageId}`)
      .then((res) => { if (!cancelled) setData(res.source); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, sourceMessageId]);

  const receivedLabel = data?.received_at
    ? new Date(data.received_at).toLocaleString(locale === "he" ? "he-IL" : "en-US")
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="text-base break-words" dir="auto">
            {data?.subject || (loading ? t("title") : t("noSubject"))}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {!loading && error && (
          <p className="text-sm text-muted-foreground">{t("loadError")}</p>
        )}

        {!loading && !error && data && (
          <div className="space-y-3 text-sm">
            <div className="text-muted-foreground">
              <span className="font-medium">{t("from")}: </span>
              <span dir="auto" className="inline-block align-bottom">{data.sender || data.sender_email || "—"}</span>
              {receivedLabel && (
                <span className="block text-xs mt-0.5">{receivedLabel}</span>
              )}
            </div>

            {(() => {
              const body = data.body_text;
              if (!body) {
                return <p className="text-muted-foreground">{t("noContent")}</p>;
              }
              // Real HTML email → render faithfully in the sandboxed iframe.
              if (hasRenderableHtml(body)) {
                return (
                  <iframe
                    title="email"
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={withBaseTarget(body)}
                    referrerPolicy="no-referrer"
                    className="w-full rounded border bg-white"
                    style={{ height: iframeHeight }}
                    onLoad={(e) => {
                      // Size the frame to its content (capped) so short emails
                      // don't leave a big empty box and long ones scroll inside.
                      try {
                        const doc = e.currentTarget.contentDocument;
                        if (doc?.body) {
                          const h = Math.min(doc.body.scrollHeight + 24, window.innerHeight * 0.6);
                          if (h > 0) setIframeHeight(h);
                        }
                      } catch { /* opaque origin — keep default height */ }
                    }}
                  />
                );
              }
              // Otherwise extract readable text. If nothing usable survives
              // (e.g. the stored body is just a truncated stylesheet), show the
              // empty state + the "open in Gmail" escape hatch below, instead
              // of dumping CSS/markup at the user.
              const text = extractReadableText(body);
              const stillNoise = !text || /[{}]|!important|@media|-webkit-/.test(text);
              return stillNoise ? (
                <p className="text-muted-foreground">{t("noContent")}</p>
              ) : (
                <div className="whitespace-pre-wrap break-words leading-relaxed" dir="auto">
                  {linkify(text)}
                </div>
              );
            })()}

            {data.source_url && (
              <a
                href={data.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline text-xs pt-1"
              >
                <ExternalLink className="h-3 w-3" />
                {t("openInGmail")}
              </a>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
