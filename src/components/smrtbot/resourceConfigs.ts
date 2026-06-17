/**
 * Field/column configs for the generic ResourceManager — one entry per per-bot
 * smrtBot resource. Drives the list columns and the add/edit form. Field labels
 * resolve via t(`f_<key>`) with a fallback to the raw key, so adding an i18n key
 * is optional (technical fields show their column name).
 */
export type FieldType = "text" | "textarea" | "number" | "bool" | "select" | "buttons";

export interface FieldDef {
  key: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
}

export interface ResourceConfig {
  /** URL segment + list-response key (matches the backend route). */
  resource: string;
  /** Columns shown in the list table. */
  columns: string[];
  /** Editable fields in the add/edit form. */
  fields: FieldDef[];
  /** Whether the resource is env-scoped (test/live filter + field). */
  hasEnv?: boolean;
  /** Hide the "Add" button (read-mostly resources populated by the bot). */
  readOnlyCreate?: boolean;
  /** Extra per-row POST actions, e.g. send-reply / promote-to-FAQ. POSTs to
   *  /api/bot/:botId/<resource>/:id/<key> and reloads. */
  rowActions?: { key: string }[];
}

const ENV: FieldDef = { key: "env", type: "select", options: ["test", "live"] };
const ACTIVE: FieldDef = { key: "active", type: "bool" };

export const RESOURCES: Record<string, ResourceConfig> = {
  menu: {
    resource: "menu",
    columns: ["node_key", "label", "type", "env"],
    hasEnv: true,
    fields: [
      { key: "node_key", type: "text", required: true },
      { key: "label", type: "text", required: true },
      { key: "title_he", type: "text" },
      { key: "body_text", type: "textarea" },
      { key: "type", type: "select", options: ["menu", "text"] },
      { key: "parent_key", type: "text" },
      { key: "action", type: "text" },
      { key: "image_url", type: "text" },
      { key: "sort_order", type: "number" },
      ENV, ACTIVE,
    ],
  },
  messages: {
    resource: "messages",
    columns: ["msg_key", "label", "env"],
    hasEnv: true,
    fields: [
      { key: "msg_key", type: "text", required: true },
      { key: "label", type: "text", required: true },
      { key: "text", type: "textarea", required: true },
      { key: "category", type: "text" },
      ENV,
    ],
  },
  missions: {
    resource: "missions",
    columns: ["mission_id", "title", "reward_diamonds", "env"],
    hasEnv: true,
    fields: [
      { key: "mission_id", type: "text", required: true },
      { key: "title", type: "text", required: true },
      { key: "content", type: "textarea" },
      { key: "reward_diamonds", type: "number" },
      { key: "success_message", type: "text" },
      { key: "sort_order", type: "number" },
      ENV, ACTIVE,
    ],
  },
  trivia: {
    resource: "trivia",
    columns: ["video_id", "level", "question", "env"],
    hasEnv: true,
    fields: [
      { key: "video_id", type: "text", required: true },
      { key: "level", type: "select", options: ["easy", "medium", "hard"] },
      { key: "question", type: "textarea", required: true },
      { key: "option_1", type: "text", required: true },
      { key: "option_2", type: "text", required: true },
      { key: "option_3", type: "text" },
      { key: "correct_option", type: "number" },
      { key: "source", type: "text" },
      ENV, ACTIVE,
    ],
  },
  knowledge: {
    resource: "knowledge",
    columns: ["question_pattern", "category", "env"],
    hasEnv: true,
    fields: [
      { key: "question_pattern", type: "text", required: true },
      { key: "question", type: "text" },
      { key: "keywords", type: "text" },
      { key: "answer", type: "textarea", required: true },
      { key: "category", type: "text" },
      { key: "sort_order", type: "number" },
      ENV, ACTIVE,
    ],
  },
  holidays: {
    resource: "holidays",
    columns: ["holiday_name", "hebrew_date", "env"],
    hasEnv: true,
    fields: [
      { key: "holiday_name", type: "text", required: true },
      { key: "holiday_group", type: "text" },
      { key: "hebrew_date", type: "text" },
      { key: "start_date", type: "text" },
      { key: "end_date", type: "text" },
      { key: "display_emoji", type: "text" },
      { key: "sort_order", type: "number" },
      ENV, ACTIVE,
    ],
  },
  "auto-messages": {
    resource: "auto-messages",
    columns: ["name", "msg_type", "env"],
    hasEnv: true,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "msg_type", type: "select", options: ["Text", "Image"] },
      { key: "wait_time", type: "number" },
      { key: "unit", type: "select", options: ["Minutes", "Hours"] },
      { key: "content", type: "textarea", required: true },
      { key: "media_url", type: "text" },
      ENV, ACTIVE,
    ],
  },
  scheduled: {
    resource: "scheduled",
    columns: ["name", "inactivity_minutes", "env"],
    hasEnv: true,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "inactivity_minutes", type: "number" },
      { key: "send_after_minutes", type: "number" },
      { key: "body_text", type: "textarea" },
      { key: "image_url", type: "text" },
      ENV, ACTIVE,
    ],
  },
  coupons: {
    resource: "coupons",
    columns: ["coupon_code", "status", "raffle_type"],
    fields: [
      { key: "coupon_code", type: "text", required: true },
      { key: "description", type: "text" },
      { key: "status", type: "select", options: ["available", "used", "expired"] },
      { key: "raffle_type", type: "select", options: ["Diamonds", "Referrals"] },
    ],
  },
  raffles: {
    resource: "raffles",
    columns: ["raffle_date", "raffle_type", "status"],
    fields: [
      { key: "raffle_date", type: "text" },
      { key: "hebrew_date", type: "text" },
      { key: "raffle_type", type: "select", options: ["Diamonds", "Referrals"] },
      { key: "status", type: "select", options: ["Pending", "Drawing", "Completed"] },
      { key: "coupon_code", type: "text" },
      { key: "notes", type: "textarea" },
    ],
  },
  children: {
    resource: "children",
    columns: ["child_name", "phone", "diamonds"],
    fields: [
      { key: "child_id", type: "text", required: true },
      { key: "child_name", type: "text" },
      { key: "phone", type: "text" },
      { key: "hebrew_birthday", type: "text" },
      { key: "diamonds", type: "number" },
      { key: "reminder_time", type: "text" },
      { key: "active_reminders", type: "bool" },
    ],
  },
  "phone-routes": {
    resource: "phone-routes",
    columns: ["label", "match_type", "match_value", "response_mode", "priority", "env"],
    hasEnv: true,
    fields: [
      { key: "label", type: "text" },
      { key: "match_type", type: "select", options: ["phone", "prefix", "tag"], required: true },
      { key: "match_value", type: "textarea", required: true },
      { key: "response_mode", type: "select", options: ["node", "reply", "ai_pm"], required: true },
      { key: "target_node_key", type: "text" },
      { key: "reply_text", type: "textarea" },
      { key: "reply_buttons", type: "buttons" },
      { key: "priority", type: "number" },
      ENV, ACTIVE,
    ],
  },
  contacts: {
    resource: "contacts",
    columns: ["phone", "name", "tags", "last_interaction_at"],
    // Rows are created by the engine on first contact (UNIQUE bot_id,phone).
    // Admins edit them here (mainly to set tags for tag-based routing) rather
    // than create — a manual create would collide with the engine's row.
    readOnlyCreate: true,
    fields: [
      { key: "name", type: "text" },
      { key: "tags", type: "text" },
      { key: "wa_opted_out", type: "bool" },
    ],
  },
  "study-sessions": {
    resource: "study-sessions",
    columns: ["phone", "started_at", "minutes", "status"],
    readOnlyCreate: true,
    fields: [
      { key: "status", type: "select", options: ["active", "completed", "cancelled"] },
      { key: "minutes", type: "number" },
    ],
  },
  prayers: {
    resource: "prayers",
    columns: ["phone", "prayer_date", "minutes", "in_minyan"],
    readOnlyCreate: true,
    fields: [
      { key: "in_minyan", type: "bool" },
      { key: "minutes", type: "number" },
    ],
  },
  "pm-projects": {
    resource: "pm-projects",
    columns: ["name", "phone", "entry_count", "status"],
    readOnlyCreate: true,
    fields: [
      { key: "name", type: "text" },
      { key: "description", type: "textarea" },
      { key: "status", type: "select", options: ["active", "archived"] },
    ],
  },
  "pm-entries": {
    resource: "pm-entries",
    columns: ["phone", "type", "summary", "status"],
    readOnlyCreate: true,
    fields: [
      { key: "summary", type: "textarea" },
      { key: "status", type: "select", options: ["pending", "confirmed", "discarded"] },
    ],
  },
  "webhook-debug": {
    resource: "webhook-debug",
    columns: ["created_at", "outcome", "detail", "slug"],
    readOnlyCreate: true,
    fields: [],
  },
  questions: {
    resource: "questions",
    columns: ["phone", "message_text", "status"],
    readOnlyCreate: true,
    rowActions: [{ key: "reply" }, { key: "promote" }],
    fields: [
      { key: "status", type: "select", options: ["pending", "answered", "ignored"] },
      { key: "admin_reply", type: "textarea" },
      { key: "needs_human", type: "bool" },
    ],
  },
  feedback: {
    resource: "feedback",
    columns: ["phone", "status"],
    readOnlyCreate: true,
    fields: [
      { key: "status", type: "select", options: ["new", "read", "archived"] },
      { key: "admin_note", type: "textarea" },
    ],
  },
};

export const RESOURCE_ORDER = [
  "menu", "messages", "knowledge", "phone-routes", "holidays",
  "auto-messages", "scheduled", "missions", "trivia", "coupons", "raffles",
  "children", "contacts", "study-sessions", "prayers",
  "pm-projects", "pm-entries", "webhook-debug", "questions", "feedback",
] as const;
