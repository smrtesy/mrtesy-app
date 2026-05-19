/**
 * Decide whether a message body should render right-to-left (Hebrew /
 * Arabic / Yiddish) or left-to-right (everything else). We don't run a
 * full language detector — checking for the first script character in
 * the Hebrew or Arabic Unicode blocks is enough for our content.
 *
 * Shared across ThreadList (preview text in the chat list) and
 * ThreadView (message bubbles in the open chat) so the visual treatment
 * is consistent everywhere.
 */
export function detectMessageDir(text: string | null | undefined): "ltr" | "rtl" {
  if (!text) return "ltr";
  // Hebrew (U+0590–U+05FF) + Arabic (U+0600–U+06FF).
  return /[֐-ۿ]/.test(text) ? "rtl" : "ltr";
}
