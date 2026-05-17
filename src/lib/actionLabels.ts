/**
 * Maps backend action keys (e.g. "draft_reply_he") to i18n keys under
 * `tasks.actions.labels.<key>`. If a label string from Claude doesn't match
 * a known action key, we render it as-is — that handles ad-hoc / Hebrew
 * action names the classifier may produce.
 */

const KNOWN_ACTIONS = new Set([
  "draft_reply_he",
  "draft_reply_en",
  "draft_whatsapp_he",
  "draft_whatsapp_en",
  "summarize_history",
  "find_in_emails",
  "check_past_handling",
  "set_reminder",
  "call_preparation",
  "financial_advisor",
  "draft_settlement_request",
  "custom",
]);

type Translator = (key: string) => string;

export function translateActionLabel(label: string, t: Translator): string {
  if (KNOWN_ACTIONS.has(label)) {
    try {
      return t(`labels.${label}`);
    } catch {
      return label;
    }
  }
  return label;
}
