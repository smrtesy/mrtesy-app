"use client";

import { Fragment, type ReactNode, type MouseEvent } from "react";

/**
 * Light-markdown renderer for Info Center cards and the pinned AI summary.
 * Supports exactly what the board's editor produces — no more:
 *   **bold**, *italic*, [text](url), bare URLs, newlines.
 *
 * Built from React elements only (no dangerouslySetInnerHTML). URLs are
 * emitted verbatim — the product's "preserve deep links" rule means one click
 * lands the user on the exact page (query params and fragments intact).
 * Same URL pattern as LinkifiedText.
 */

const URL_SRC = "https?:\\/\\/[^\\s<>\"'`)\\]]+";

// Inline token alternation. Order matters: md-link before bold/italic before
// bare URL, so "[x](url)" isn't half-consumed by the bare-URL branch.
//   m[1]+m[2] → [text](href)   m[3] → **bold**   m[4] → *italic*   m[5] → bare URL
const TOKEN_SRC =
  `\\[([^\\]\\n]+)\\]\\((${URL_SRC})\\)` +
  `|\\*\\*([^*\\n]+)\\*\\*` +
  `|\\*([^*\\n]+)\\*` +
  `|(${URL_SRC})`;

// Keep link clicks from bubbling to a clickable parent (cards that open
// dialogs on click) — tapping a link should only follow the link.
function stop(e: MouseEvent) {
  e.stopPropagation();
}

function link(href: string, label: string, key: number): ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      className="text-primary underline break-all"
    >
      {label}
    </a>
  );
}

/** Render one line of text. `depth` guards the bold/italic recursion. */
function renderInline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  // matchAll clones the regex, so the shared source is safe to reuse.
  for (const m of text.matchAll(new RegExp(TOKEN_SRC, "g"))) {
    const start = m.index ?? 0;
    if (start > last) out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);

    if (m[1] !== undefined) {
      out.push(link(m[2], m[1], key++));
    } else if (m[3] !== undefined) {
      out.push(
        <strong key={key++}>
          {depth < 2 ? renderInline(m[3], depth + 1) : m[3]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      out.push(
        <em key={key++}>
          {depth < 2 ? renderInline(m[4], depth + 1) : m[4]}
        </em>,
      );
    } else if (m[5] !== undefined) {
      out.push(link(m[5], m[5], key++));
    }

    last = start + m[0].length;
  }

  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out;
}

interface Props {
  children: string | null | undefined;
  className?: string;
}

export function MarkdownLite({ children, className }: Props) {
  const text = children ?? "";
  if (!text) return null;

  const lines = text.split("\n");
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`br-${i}`} />);
    out.push(<Fragment key={`l-${i}`}>{renderInline(line)}</Fragment>);
  });

  return (
    <span className={className} dir="auto">
      {out}
    </span>
  );
}
