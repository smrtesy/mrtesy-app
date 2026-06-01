// Shared email-body extraction for the Gmail collectors (gmail-sync,
// batch-details). The product only needs the *text* of an email — styling is
// irrelevant for AI processing and for the in-app reader. So we:
//   1. walk the MIME tree recursively and prefer text/plain,
//   2. fall back to text/html converted to clean text (no <style>/CSS/tags),
//   3. never store raw HTML/CSS.
// This also fixes a latent bug: decoding base64 with atob() alone mangles
// UTF-8 (Hebrew) bodies into mojibake; we decode the bytes as UTF-8.

// Minimal Gmail message payload shape (the API returns much more; we only
// touch these fields).
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/** Decode Gmail's base64url part data into a UTF-8 string. Returns "" on
 *  malformed input rather than throwing — a single bad body must never abort
 *  the whole sync loop (gmail-sync has no per-message try/catch). */
function decodeB64Url(data: string): string {
  try {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

/** First leaf part (depth-first) whose mimeType matches and has body data. */
function findPartData(node: GmailPart | undefined, mime: string): string | null {
  if (!node) return null;
  if (node.mimeType === mime && node.body?.data) return node.body.data;
  if (Array.isArray(node.parts)) {
    for (const p of node.parts) {
      const found = findPartData(p, mime);
      if (found) return found;
    }
  }
  return null;
}

function looksLikeHtml(text: string): boolean {
  return /<(!doctype|html|head|body|table|tr|td|div|p|br|span|style|a|img|ul|ol)\b/i.test(text);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

/**
 * Convert an HTML email body to readable plain text. Drops style/script/head
 * and (for bodies that leak naked CSS rules) CSS blocks, turns block-level
 * tags into line breaks, strips the rest, and decodes entities.
 */
export function htmlToText(raw: string): string {
  // Bound regex work on pathologically large bodies; we only keep ~10k chars
  // of clean text downstream, and real content sits well within this window.
  let s = (raw.length > 100_000 ? raw.slice(0, 100_000) : raw)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
  // Some senders' bodies are a naked stylesheet (no <style> wrapper). Strip
  // CSS rule blocks only when the text actually contains `{…}`, so plain text
  // is never touched.
  if (s.includes("{") && s.includes("}")) {
    s = s.replace(/@media[^{]*\{(?:[^{}]+|\{[^{}]*\})*\}/gi, " ");
    s = s.replace(/[^{}<>;]+\{[^{}]*\}/g, " ");
  }
  // Preserve link targets: keep the href as visible text so deep links the
  // sender included survive into the stored body (product rule: never lose a
  // URL that lets one click land on the right page).
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, " $1 ");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the best plain-text body from a Gmail message payload.
 * Preference: text/plain (verbatim) → text/html (converted to text) →
 * single-part body (converted if it looks like HTML). Always returns text,
 * never raw HTML/CSS.
 */
export function extractEmailBody(payload: GmailPart | undefined): string {
  if (!payload) return "";

  const plain = findPartData(payload, "text/plain");
  if (plain) return decodeB64Url(plain);

  const html = findPartData(payload, "text/html");
  if (html) return htmlToText(decodeB64Url(html));

  // Single-part message: the body sits directly on the payload.
  if (payload.body?.data) {
    const raw = decodeB64Url(payload.body.data);
    return payload.mimeType === "text/html" || looksLikeHtml(raw) ? htmlToText(raw) : raw;
  }

  return "";
}
