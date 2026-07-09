/** A take's note, sanitized for use at the end of a download filename. Keeps
 *  Hebrew/spaces readable; strips characters illegal in a filename plus control
 *  chars/newlines. Empty note → no suffix. Mirrors the server-side helper in
 *  the archive route. */
export function noteSuffix(note: string | null): string {
  // eslint-disable-next-line no-control-regex
  const clean = (note ?? "").replace(/[/\\:*?"<>|\x00-\x1f]/g, "").trim();
  return clean ? `_${clean}` : "";
}
