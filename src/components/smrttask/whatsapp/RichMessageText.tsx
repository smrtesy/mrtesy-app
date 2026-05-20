"use client";

/**
 * Render WhatsApp / Markdown-style formatted message text:
 *   **bold**        Markdown bold  → <strong>
 *   *bold*          WhatsApp bold  → <strong>
 *   _italic_        both           → <em>
 *   ~strike~        WhatsApp       → <s>
 *   ~~strike~~      Markdown       → <s>
 *   `code`          both           → <code>
 *   ```code```      block          → <pre><code>
 *   URLs            auto-linkified → <a>
 *
 * Per-line direction: each line gets `dir="auto"` so Hebrew lines snap
 * right and English lines snap left inside the same bubble — which is
 * what users expect for mixed-language chat content.
 *
 * Chat-focused, NOT a general markdown renderer — we intentionally
 * ignore headings/lists/blockquotes/tables.
 */

import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  text: string;
  className?: string;
}

export function RichMessageText({ text, className }: Props) {
  if (!text) return null;

  // 1) Split on triple-backtick code blocks so their contents bypass all
  //    further parsing (otherwise a `*` inside code would render as bold).
  const segments = splitCodeBlocks(text);

  return (
    <div className={cn("whitespace-pre-wrap break-words leading-snug", className)}>
      {segments.map((seg, idx) =>
        seg.kind === "code" ? (
          <pre
            key={idx}
            dir="ltr"
            className="my-1 overflow-x-auto rounded bg-black/[0.06] px-2 py-1.5 font-mono text-[12px]"
          >
            <code>{seg.content}</code>
          </pre>
        ) : (
          <InlineLines key={idx} text={seg.content} />
        ),
      )}
    </div>
  );
}

interface Segment { kind: "text" | "code"; content: string; }

function splitCodeBlocks(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", content: text.slice(last, m.index) });
    out.push({ kind: "code", content: m[1].replace(/^[a-zA-Z0-9_-]*\n/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: "text", content: text.slice(last) });
  return out.length > 0 ? out : [{ kind: "text", content: text }];
}

/** Per-line so each line gets dir="auto" independently. */
function InlineLines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line.length === 0 ? (
            <br />
          ) : (
            <span dir="auto" className="block">
              {renderInline(line)}
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

// ── Inline parser ───────────────────────────────────────────────────────
//
// Strategy: walk the string left-to-right; at each position, try to match
// the highest-priority formatter. If nothing matches, emit one literal
// character and advance. Recursion handles nested formatting (bold inside
// italic, italic inside bold).

interface Matcher {
  re: RegExp;
  build: (match: RegExpExecArray) => ReactNode;
}

const URL_RE = /^(https?:\/\/[^\s<>"'`]+)/;
const INLINE_CODE_RE = /^`([^`\n]+)`/;
const MD_BOLD_RE = /^\*\*(?!\s)([^\n](?:[^\n]*?[^\s])?)\*\*/;          // **bold**
const WA_BOLD_RE = /^\*(?!\s)([^*\n](?:[^*\n]*?[^\s*])?)\*(?![*\w])/;   // *bold*
const MD_STRIKE_RE = /^~~(?!\s)([^\n](?:[^\n]*?[^\s])?)~~/;             // ~~strike~~
const WA_STRIKE_RE = /^~(?!\s)([^~\n](?:[^~\n]*?[^\s~])?)~(?![~\w])/;   // ~strike~
const ITALIC_RE  = /^_(?!\s)([^_\n](?:[^_\n]*?[^\s_])?)_(?![_\w])/;     // _italic_

function renderInline(line: string): ReactNode {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf.length > 0) { out.push(<Fragment key={`t${key++}`}>{buf}</Fragment>); buf = ""; }
  };

  const matchers: Matcher[] = [
    {
      re: URL_RE,
      build: (m) => (
        <a key={`m${key++}`} href={m[1]} target="_blank" rel="noopener noreferrer"
           dir="ltr" className="text-blue-600 underline break-all">
          {m[1]}
        </a>
      ),
    },
    {
      re: INLINE_CODE_RE,
      build: (m) => (
        <code key={`m${key++}`} dir="ltr" className="rounded bg-black/[0.06] px-1 font-mono text-[12px]">
          {m[1]}
        </code>
      ),
    },
    { re: MD_BOLD_RE,   build: (m) => <strong key={`m${key++}`}>{renderInline(m[1])}</strong> },
    { re: WA_BOLD_RE,   build: (m) => <strong key={`m${key++}`}>{renderInline(m[1])}</strong> },
    { re: MD_STRIKE_RE, build: (m) => <s key={`m${key++}`}>{renderInline(m[1])}</s> },
    { re: WA_STRIKE_RE, build: (m) => <s key={`m${key++}`}>{renderInline(m[1])}</s> },
    { re: ITALIC_RE,    build: (m) => <em key={`m${key++}`}>{renderInline(m[1])}</em> },
  ];

  while (i < line.length) {
    const rest = line.slice(i);
    let matched = false;
    for (const m of matchers) {
      const r = m.re.exec(rest);
      if (r && r.index === 0) {
        flush();
        out.push(m.build(r));
        i += r[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      buf += line[i];
      i++;
    }
  }
  flush();
  return out;
}
