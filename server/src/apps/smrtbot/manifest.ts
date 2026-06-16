import type { AppManifest } from "../../lib/platform/types";

/**
 * smrtBot — WhatsApp conversational engine + WhatsApp transport.
 *
 * Migrated from the legacy `botsite` app. Owns the bots, their WhatsApp
 * credentials, the conversation engine (menu / game / FAQ / video), and the
 * outbound WhatsApp transport (send-service) that smrtReach calls for
 * broadcast campaigns.
 *
 * NOT owned here: contacts (→ smrtCRM) and broadcast campaigns (→ smrtReach).
 */
export const manifest: AppManifest = {
  slug: "smrtbot",
  name: "smrtBot",

  emits: [
    "bot.created",
    "bot.published",
    "contact.observed", // a wa_user interacted — smrtCRM ingests this
    "mission.completed",
    "trivia.answered",
    "raffle.drawn",
    "coupon.awarded",
    "question.received",
    "feedback.received",
  ],

  subscribes: [],

  notifications: {
    "raffle.drawn": {
      type: "success",
      title: (p) => `הוגרלה הגרלה: ${String(p.raffle_type ?? "")}`,
      body: (p) => `זוכה: ${String(p.winner_child_id ?? "—")}`,
    },
    "question.received": {
      type: "action_required",
      title: "שאלה חדשה ממתינה למענה",
      body: (p) => String(p.message_text ?? ""),
    },
  },

  entities: {
    reads: [],
    writes: [
      "smrtbot_bots",
      "smrtbot_bot_access",
      "smrtbot_wa_users",
      "smrtbot_phone_routes",
      "smrtbot_menu_nodes",
      "smrtbot_messages",
      "smrtbot_missions",
      "smrtbot_trivia",
      "smrtbot_raffles",
      "smrtbot_coupons",
      "smrtbot_children",
      "smrtbot_diamonds_log",
      "smrtbot_knowledge_base",
      "smrtbot_auto_messages",
      "smrtbot_holidays",
      "smrtbot_settings",
      "smrtbot_scheduled_configs",
      "smrtbot_scheduled_logs",
      "smrtbot_questions",
      "smrtbot_feedback",
      "smrtbot_videos",
      "smrtbot_referral_log",
      "smrtbot_publish_batches",
      "smrtbot_bot_logs",
      "smrtbot_audit_log",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: [
      "WhatsApp send failed (Meta API)",
      "Webhook verify token mismatch",
      "Video index sync failed",
      "Scheduled broadcast batch error",
    ],
  },
};
