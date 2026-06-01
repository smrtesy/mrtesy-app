"use client";

import { Fragment, type ReactNode, type MouseEvent } from "react";

// Patterns. URLs and emails are matched verbatim; phone candidates are matched
// loosely and then validated (see isPhone) so we don't turn dates, times, or
// numeric IDs/serials (e.g. "2.6.2026", "4:00", "TABS: 477837") into tel: links.
//   - URL: stop before whitespace, quotes/brackets, and a trailing ")".
//   - EMAIL: standard local@domain.tld.
//   - PHONE: optional "+" or "(" lead-in, then a run of digits/space/()-.
const URL = "https?:\\/\\/[^\\s<>\"'`)\\]]+";
const EMAIL = "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+";
const PHONE = "\\+?[\\d(][\\d\\s()\\-]{7,}\\d";
const TOKEN_RE = new RegExp(`(${URL})|(${EMAIL})|(${PHONE})`, "g");

// A phone candidate is real only if it carries ≥9 digits AND has either a
// leading "+" or an internal separator (space / dash / paren). That accepts
// "(212) 908-6671" and "+972 52-123-4567" while rejecting bare numeric IDs.
function isPhone(s: string): boolean {
  const trimmed = s.trim();
  const digits = trimmed.replace(/\D/g, "");
  // ≥9 digits is a plausible phone; >15 exceeds the E.164 max and is almost
  // certainly an ISBN / account number / other long grouped figure.
  if (digits.length < 9 || digits.length > 15) return false;
  return trimmed.startsWith("+") || /[\s()-]/.test(trimmed);
}

// Keep link clicks from bubbling to a clickable parent — a TaskCard opens the
// detail sheet on click, and an update row toggles expand on click; tapping a
// link should do neither.
function stop(e: MouseEvent) {
  e.stopPropagation();
}

interface Props {
  children: string | null | undefined;
  className?: string;
}

/**
 * Renders plain text, turning bare URLs, emails, and phone numbers into
 * clickable links. URLs are emitted verbatim — the product's "preserve deep
 * links" rule means one click lands the user on the exact page (query params and
 * fragments intact), never a stripped-down homepage. Email → mailto:, phone →
 * tel:. Whitespace is preserved by the parent (e.g. `whitespace-pre-wrap`).
 */
export function LinkifiedText({ children, className }: Props) {
  const text = children ?? "";
  if (!text) return null;

  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const m of text.matchAll(TOKEN_RE)) {
    const value = m[0];
    const start = m.index ?? 0;

    // Phone candidate that fails validation → leave it in the plain-text run.
    if (m[3] && !isPhone(value)) continue;

    if (start > last) {
      out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    }

    if (m[1]) {
      out.push(
        <a
          key={key++}
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          dir="ltr"
          onClick={stop}
          className="text-primary underline break-all"
        >
          {value}
        </a>,
      );
    } else if (m[2]) {
      out.push(
        <a
          key={key++}
          href={`mailto:${value}`}
          dir="ltr"
          onClick={stop}
          className="text-primary underline break-all"
        >
          {value}
        </a>,
      );
    } else {
      out.push(
        <a
          key={key++}
          href={`tel:${value.replace(/[^\d+]/g, "")}`}
          dir="ltr"
          onClick={stop}
          className="text-primary underline whitespace-nowrap"
        >
          {value}
        </a>,
      );
    }

    last = start + value.length;
  }

  if (last < text.length) {
    out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  }

  if (className) return <span className={className}>{out}</span>;
  return <>{out}</>;
}
