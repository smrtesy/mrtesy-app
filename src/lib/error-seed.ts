/**
 * Compose the Claude diagnostic seed for a captured error entry.
 *
 * Shared by every "send this error to Claude" entry point — the sidebar bell
 * (SystemMessagesBell) and the global catcher's toast action (ClientErrorCatcher)
 * — so the seed reads identically whichever surface launched it. It builds on
 * the same inspect-seed contract ClaudeChat consumes (deliverInspectSeed).
 *
 * The seed does two things for Claude: (1) hands over the full captured context
 * (message, endpoint, status, response body, stack, route, time, browser), and
 * (2) instructs Claude to FIRST screenshot the real rendered screen server-side
 * via the browser-helper — that is the "automatic screenshot" of the full-mode
 * design: a real pixel render, taken on the subscription at zero paid cost, is
 * strictly better than an imperfect in-page html2canvas image.
 */

import type { SystemMessageEntry } from "./system-messages";

type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * @param entry         The captured error (text + path + optional rich detail).
 * @param t             next-intl translator scoped to the `systemMessages` namespace.
 * @param formattedTime The entry time already formatted for America/New_York.
 * @param userAgent     navigator.userAgent (passed in so this stays SSR-safe).
 */
export function composeDebugSeed(
  entry: SystemMessageEntry,
  t: Translator,
  formattedTime: string,
  userAgent: string,
): string {
  const d = entry.detail;
  const lines: string[] = [
    t("seedHeader"),
    "",
    `- ${t("seedMessage")}: "${entry.text}"`,
    `- ${t("seedRoute")}: \`${entry.path}\``,
    `- ${t("seedTime")}: ${formattedTime} (America/New_York)`,
    `- ${t("seedBrowser")}: ${userAgent}`,
  ];

  if (d?.method || d?.url) {
    lines.push(`- ${t("seedEndpoint")}: \`${(d.method ?? "GET")} ${d.url ?? ""}\``);
  }
  if (typeof d?.status === "number") {
    lines.push(`- ${t("seedStatus")}: ${d.status}`);
  }
  if (d?.responseBody) {
    lines.push(`- ${t("seedResponse")}: \`${d.responseBody.slice(0, 500)}\``);
  }
  if (d?.stack) {
    lines.push("", `${t("seedStack")}:`, "```", d.stack.slice(0, 1500), "```");
  }

  lines.push(
    "",
    t("seedScreenshot", { route: entry.path }),
    "",
    t("seedTask"),
    "",
    `${t("seedProblem")} `,
  );

  return lines.join("\n");
}
