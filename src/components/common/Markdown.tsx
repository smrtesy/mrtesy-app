"use client";

/**
 * Markdown — GitHub-style rendering for .md content, RTL-aware.
 *
 * Why this exists: every screen that shows a real markdown document (הוראות
 * קבועות, the docs browser, app plans) used to dump the raw source into a
 * mono `<pre>`. Headings, tables and links were unreadable, and a Hebrew doc
 * rendered left-aligned. This renders the same documents the way GitHub does
 * — headings with rules, real tables, styled code and blockquotes — and adds
 * the thing GitHub does NOT do: direction that follows the language.
 *
 * Direction rules (the "ישור נכון לפי שפה" part):
 *   - Every block element gets `dir="auto"`, so a Hebrew paragraph aligns
 *     right and an English one inside the same document aligns left. No
 *     locale prop, no `locale === "he" ?` ternaries — the text decides.
 *   - A table's direction is decided by the majority script of its own text,
 *     so a Hebrew table puts its FIRST column on the right (GitHub keeps it
 *     on the left, which reads backwards in Hebrew). Explicit GFM column
 *     alignment (`:---:`, `---:`) still wins — it arrives as an inline
 *     `text-align` style and inline styles beat our classes.
 *   - Code is always LTR: source is LTR even inside a Hebrew document.
 *
 * Safety: no `rehype-raw` — raw HTML embedded in a document is escaped, not
 * executed. Content here is org-authored and reaches other members of the
 * org, so we do not hand it an HTML injection surface.
 *
 * Links are emitted verbatim (query params, fragments, IDs intact) per the
 * repo's deep-link rule, and open in a new tab.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* direction                                                           */
/* ------------------------------------------------------------------ */

/** Hebrew, Arabic, Syriac, Thaana + the Arabic presentation-form blocks. */
const RTL_FIRST = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Latin, including the accented ranges. */
// Latin-1 Supplement carries \u00D7 (\u00D7) and \u00F7 (\u00F7) mid-range; they are math
// symbols, not letters, and counting them flipped short Hebrew cells like
// "3 \u00D7 4" to LTR.
const LTR_FIRST = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/;
const RTL_LETTERS = new RegExp(RTL_FIRST.source, "g");
const LTR_LETTERS = new RegExp(LTR_FIRST.source, "g");

export type Dir = "rtl" | "ltr";

/**
 * Majority-script direction — for CONTAINERS (a table, a list, the document
 * shell). First-strong is wrong here: a table whose first cell happens to be
 * "Maor" but whose other twenty cells are Hebrew must still lay its columns
 * out right-to-left. `null` = no letters at all, so the caller inherits.
 */
export function majorityDir(text: string): Dir | null {
  const rtl = text.match(RTL_LETTERS)?.length ?? 0;
  const ltr = text.match(LTR_LETTERS)?.length ?? 0;
  if (rtl === 0 && ltr === 0) return null;
  return rtl > ltr ? "rtl" : "ltr";
}

/**
 * First-strong-character direction — for LEAF blocks (a paragraph, a heading,
 * one table cell). Matches what a reader expects from a Hebrew sentence that
 * happens to name three English products: it stays a Hebrew sentence.
 * `null` = no strong letter (digits, punctuation), so the caller inherits.
 */
export function firstStrongDir(text: string): Dir | null {
  const rtl = text.search(RTL_FIRST);
  const ltr = text.search(LTR_FIRST);
  if (rtl < 0 && ltr < 0) return null;
  if (rtl < 0) return "ltr";
  if (ltr < 0) return "rtl";
  return rtl < ltr ? "rtl" : "ltr";
}

/** Flatten a React subtree to its plain text — for slugs and direction. */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (typeof node === "object" && "props" in node) {
    return toText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/**
 * Direction for a leaf block (paragraph, heading, one cell). `undefined`
 * inherits from the container, which is what text with no letters wants.
 *
 * We compute a REAL `dir` instead of leaning on `dir="auto"`, and that is not
 * a style choice. HTML's auto algorithm ignores text inside descendants that
 * carry their own `dir` — so once every block here was `dir="auto"`, a
 * blockquote saw no text of its own and silently fell back to LTR, putting
 * its accent bar on the wrong side of a Hebrew quote. Computing the value
 * also sets the CSS `direction` property, which is what `border-s`, `ps-*`
 * and list markers actually resolve against; `dir="auto"` leaves that
 * inherited and only fixes the text run.
 */
function leafDir(children: ReactNode): Dir | undefined {
  return firstStrongDir(toText(children)) ?? undefined;
}

/** Direction for a container (list, quote, table, the document shell). */
function boxDir(children: ReactNode): Dir | undefined {
  return majorityDir(toText(children)) ?? undefined;
}

/**
 * Heading id, GitHub-flavoured but Unicode-safe so Hebrew headings get a real
 * anchor instead of an empty one. Deliberately a pure function of the text —
 * no occurrence counter — so the id is stable across re-renders. Two headings
 * with identical text share an id; the anchor then jumps to the first, which
 * is a better failure than ids that shift under the user's feet.
 */
function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, "-")
      // Keep letters/digits/marks from any script (Hebrew included) + - and _.
      .replace(/[^\p{L}\p{N}\p{M}_-]/gu, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** The handful of strings this renderer owns. Supplied by the caller's i18n. */
interface Labels {
  /** aria-label for a heading's anchor. `{title}` = the heading text. */
  anchor: (title: string) => string;
  copyCode: string;
  copied: string;
}

const ABSOLUTE_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/** Physical text-align for a known direction; `undefined` keeps inheritance. */
function alignFor(dir: Dir | undefined): string | undefined {
  return dir === "rtl" ? "text-right" : dir === "ltr" ? "text-left" : undefined;
}

/**
 * Resolve a link the way the *document's* reader expects.
 *
 * Markdown docs cross-reference each other relatively (`./feasibility.md`).
 * Rendered inside the app those used to resolve against the app origin and
 * 404 — a link that promises navigation and delivers a dead tab. So a caller
 * that knows where the document actually lives passes `linkBase` and we
 * rebuild the real deep link; a caller that doesn't gets inert text instead
 * of a broken link. Absolute/mailto/anchor hrefs are never touched.
 *
 * `null` = do not render this as a link.
 */
function resolveHref(href: string | undefined, linkBase?: string): string | null {
  if (!href) return null;
  if (ABSOLUTE_HREF.test(href)) return href;
  if (!linkBase) return null;
  try {
    return new URL(href, linkBase).toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

/** Heading + the hover anchor GitHub shows, so any section is deep-linkable. */
function Heading({
  level,
  children,
  className,
  labels,
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: ReactNode;
  className: string;
  labels: Labels;
}) {
  const Tag = `h${level}` as const;
  const text = toText(children);
  const id = slugify(text);
  return (
    <Tag id={id} dir={leafDir(children)} className={cn("group/h scroll-mt-16", className)}>
      {children}
      <a
        href={`#${encodeURIComponent(id)}`}
        aria-label={labels.anchor(text)}
        // Revealed on hover, but a keyboard tab must not land on something
        // invisible — hence focus-visible alongside the hover reveal.
        className="ms-2 align-middle text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/h:opacity-100 touch:opacity-60"
      >
        #
      </a>
    </Tag>
  );
}

/** Fenced code block: horizontal scroll, forced LTR, quiet copy button. */
function CodeBlock({ children, labels }: { children: ReactNode; labels: Labels }) {
  const [copied, setCopied] = useState(false);
  // Same trailing-newline strip the <code> renderer applies, so what lands on
  // the clipboard matches what the user sees in the box.
  const text = toText(children).replace(/\n$/, "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context / denied) — nothing to recover */
    }
  }

  return (
    <div className="group/code relative my-3">
      <pre
        dir="ltr"
        className={cn(
          "overflow-x-auto rounded-lg border bg-muted/50 p-3 text-start",
          "font-mono text-[12.5px] leading-relaxed",
          // The inner <code> carries the inline-code pill styling; strip it
          // back off inside a block so the pill doesn't nest in the box.
          "[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit [&>code]:font-mono",
        )}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? labels.copied : labels.copyCode}
        title={copied ? labels.copied : labels.copyCode}
        className={cn(
          "absolute end-2 top-2 rounded-md border bg-background/90 p-1.5 text-muted-foreground",
          "opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 touch:opacity-100",
        )}
      >
        {copied ? <Check className="size-3.5 text-status-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** GFM table: its own direction + its own horizontal scroll container. */
function Table({ children }: { children: ReactNode }) {
  const dir = boxDir(children);
  return (
    <div className="my-3 w-full overflow-x-auto">
      <table dir={dir} className="w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* renderer                                                            */
/* ------------------------------------------------------------------ */

/**
 * The component map is built per (linkBase, labels) pair rather than declared
 * once at module scope, because both are caller-supplied. `Markdown` memoizes
 * the result so element identity stays stable across re-renders and nothing
 * remounts (which would drop a code block's "copied" state).
 */
function buildComponents(labels: Labels, linkBase?: string): Components {
  return {
    h1: ({ children }) => (
      <Heading level={1} labels={labels} className="mb-3 mt-6 border-b pb-1.5 text-2xl font-bold first:mt-0">
        {children}
      </Heading>
    ),
    h2: ({ children }) => (
      <Heading level={2} labels={labels} className="mb-2.5 mt-6 border-b pb-1.5 text-xl font-bold first:mt-0">
        {children}
      </Heading>
    ),
    h3: ({ children }) => (
      <Heading level={3} labels={labels} className="mb-2 mt-5 text-base font-semibold first:mt-0">
        {children}
      </Heading>
    ),
    h4: ({ children }) => (
      <Heading level={4} labels={labels} className="mb-1.5 mt-4 text-sm font-semibold first:mt-0">
        {children}
      </Heading>
    ),
    h5: ({ children }) => (
      <Heading level={5} labels={labels} className="mb-1.5 mt-4 text-sm font-semibold text-foreground/90 first:mt-0">
        {children}
      </Heading>
    ),
    h6: ({ children }) => (
      <Heading level={6} labels={labels} className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
        {children}
      </Heading>
    ),

    p: ({ children }) => (
      <p dir={leafDir(children)} className="my-2.5 leading-relaxed first:mt-0 last:mb-0">
        {children}
      </p>
    ),

    a: ({ href, children }) => {
      // Verbatim href — an absolute deep link keeps its path, query and
      // fragment. A relative one is rebuilt against linkBase, or rendered as
      // plain text when there is no base to rebuild it from.
      const resolved = resolveHref(href, linkBase);
      if (!resolved) return <>{children}</>;
      return (
        <a
          href={resolved}
          target={resolved.startsWith("#") ? undefined : "_blank"}
          rel="noopener noreferrer"
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary [overflow-wrap:anywhere]"
        >
          {children}
        </a>
      );
    },

    ul: ({ children }) => (
      <ul
        dir={boxDir(children)}
        className={cn(
          "my-2.5 list-disc space-y-1 ps-6 leading-relaxed marker:text-muted-foreground",
          // Explicit left/right, not `start`: the items below are
          // `unicode-bidi: plaintext`, under which `start` re-resolves per
          // ITEM and would fling a Hebrew line to the far side of an
          // English-majority list, away from its own bullet.
          alignFor(boxDir(children)),
          // Task-list items ("- [ ] …") carry their own checkbox — drop the
          // bullet. Keyed on the class remark-gfm emits, NOT on `:has(> input)`:
          // in a loose list mdast keeps the <p> wrapper, so the checkbox is a
          // grandchild and the :has() rule silently missed, leaving a bullet
          // under the checkbox. The checkbox (not the <li>) hangs into the
          // marker gutter, so a nested list under a task keeps its indentation.
          "[&_li.task-list-item]:list-none",
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children, start }) => (
      <ol
        dir={boxDir(children)}
        start={start}
        className={cn(
          "my-2.5 list-decimal space-y-1 ps-6 leading-relaxed marker:text-muted-foreground",
          alignFor(boxDir(children)),
        )}
      >
        {children}
      </ol>
    ),
    li: ({ children, className }) => (
      // `unicode-bidi: plaintext` (not dir="auto") so a lone English item in a
      // Hebrew list reads left-to-right while the bullet stays on the list's
      // side — a real `dir` here would drag the marker across the gutter.
      <li className={cn("[unicode-bidi:plaintext] [&>ul]:my-1 [&>ol]:my-1", className)}>
        {children}
      </li>
    ),
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input
          type="checkbox"
          checked={!!checked}
          readOnly
          disabled
          className="-ms-5 me-2 align-middle accent-primary"
        />
      ) : null,

    blockquote: ({ children }) => (
      <blockquote
        dir={boxDir(children)}
        className="my-3 border-s-4 border-border bg-muted/30 py-1 ps-3 text-muted-foreground [&>p]:my-1.5"
      >
        {children}
      </blockquote>
    ),

    hr: () => <hr className="my-5 border-border" />,

    pre: ({ children }) => <CodeBlock labels={labels}>{children}</CodeBlock>,
    code: ({ children, className }) => (
      <code
        dir="ltr"
        className={cn(
          "rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]",
          className,
        )}
      >
        {/* A fenced block's value always ends in "\n"; rendering it leaves a
            blank last line inside the box, which GitHub does not show. */}
        {typeof children === "string" ? children.replace(/\n$/, "") : children}
      </code>
    ),

    table: ({ children }) => <Table>{children}</Table>,
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b last:border-b-0 even:bg-muted/20">{children}</tr>,
    // `style` carries the GFM column alignment (`:---:`) and, being inline,
    // overrides `text-start` — so an explicitly aligned column stays aligned.
    th: ({ children, style }) => (
      <th
        dir={leafDir(children)}
        style={style}
        className="border px-3 py-1.5 text-start align-top font-semibold"
      >
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td dir={leafDir(children)} style={style} className="border px-3 py-1.5 text-start align-top">
        {children}
      </td>
    ),

    img: ({ src, alt }) => (
      // eslint-disable-next-line @next/next/no-img-element -- arbitrary doc-authored URLs, not app assets
      <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 max-w-full rounded-lg border" />
    ),

    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
    // GFM footnotes land in a <section class="footnotes"> at the end.
    section: ({ children, className }) => (
      <section
        dir={boxDir(children)}
        className={cn(className === "footnotes" && "mt-6 border-t pt-3 text-xs text-muted-foreground")}
      >
        {children}
      </section>
    ),
  };
}

const PLUGINS = [remarkGfm];

export interface MarkdownProps {
  children: string | null | undefined;
  className?: string;
  /**
   * Direction of the document shell. Defaults to the majority script of the
   * content; every block still resolves its own direction from its own text.
   */
  dir?: "rtl" | "ltr";
  /**
   * Absolute URL of the directory the document lives in, used to turn its
   * relative cross-references (`./plan.md`) back into real deep links. Omit
   * it and relative links render as plain text rather than as links that
   * 404 against the app's own origin.
   */
  linkBase?: string;
}

export function Markdown({ children, className, dir, linkBase }: MarkdownProps) {
  const t = useTranslations("markdown");
  const text = children ?? "";

  const rootDir = useMemo(() => dir ?? majorityDir(text) ?? "ltr", [dir, text]);
  const components = useMemo(
    () =>
      buildComponents(
        {
          anchor: (title: string) => t("anchor", { title }),
          copyCode: t("copyCode"),
          copied: t("copied"),
        },
        linkBase,
      ),
    [t, linkBase],
  );

  if (!text.trim()) return null;

  return (
    <div
      dir={rootDir}
      className={cn(
        "text-sm text-foreground [overflow-wrap:break-word]",
        // Nested lists shouldn't inherit the outer list's vertical rhythm.
        "[&_li>p]:my-0",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
