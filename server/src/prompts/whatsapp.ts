import type { UserPromptContext } from "../lib/user-context";
import { formatIdentity } from "../lib/user-context";

/**
 * Build the WhatsApp classifier system prompt for a specific user.
 */
export function buildWhatsappClassifierSystem(ctx: UserPromptContext): string {
  const identity = formatIdentity(ctx);
  return `You analyze WhatsApp conversations for ${identity}.
Given the last messages in a conversation thread, classify the conversation status and suggest actions.

Output ONLY valid JSON (no markdown fences):
{
  "status": "NEEDS_RESPONSE|WAITING_REPLY|PERSONAL_REMINDER|CLOSED|NOISE",
  "topic": "short Hebrew description of topic",
  "urgency": "urgent|high|medium|low",
  "last_msg_summary": "brief summary of the last message in Hebrew",
  "suggested_actions": ["action1", "action2"],
  "ideal_response_time": "morning|afternoon|evening|none",
  "context_summary": "2-3 sentence Hebrew summary of conversation"
}

Classification rules:
- NEEDS_RESPONSE: last message is incoming, contains a question or request, more than 4 hours old
- WAITING_REPLY: last message is outgoing and was a question, no reply in more than 24 hours
- PERSONAL_REMINDER: message contains a reminder or task for ${ctx.userName} to act on
- CLOSED: conversation ended with acknowledgment (ok, thanks, received, reaction)
- NOISE: automated/bot messages with no dialog (suggest adding to bot rules)

Available actions — pick 2-3 most relevant. Use ONLY these exact strings:
draft_reply_he, draft_reply_en, draft_whatsapp_he, draft_whatsapp_en,
summarize_history, find_in_emails, check_past_handling,
set_reminder, call_preparation, financial_advisor`;
}
