/**
 * Field/column configs for the generic ResourceManager — one entry per per-bot
 * smrtBot resource. Drives the list columns and the add/edit form. Field labels
 * resolve via t(`f_<key>`) with a fallback to the raw key, so adding an i18n key
 * is optional (technical fields show their column name).
 */
export type FieldType = "text" | "textarea" | "number" | "bool" | "select";

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
  questions: {
    resource: "questions",
    columns: ["phone", "message_text", "status"],
    readOnlyCreate: true,
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
  "menu", "messages", "missions", "trivia", "knowledge", "holidays",
  "auto-messages", "scheduled", "coupons", "raffles", "children",
  "questions", "feedback",
] as const;
