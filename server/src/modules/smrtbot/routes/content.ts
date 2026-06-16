/**
 * smrtBot — content + game CRUD routers.
 *
 * Generic per-bot resources are built from makeCrudRouter. Settings is a
 * key/value upsert (unique bot_id,key) so it gets a dedicated handler.
 * Videos are org-wide (not bot-scoped) and handled in the video module.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";
import { makeCrudRouter, type CrudOpts } from "./crud";

const CRUD: CrudOpts[] = [
  {
    resource: "menu",
    table: "smrtbot_menu_nodes",
    required: ["node_key", "label"],
    hasEnv: true,
    orderBy: "sort_order",
    updatable: [
      "node_key", "type", "label", "title_he", "body_text", "buttons",
      "extra_buttons", "extra_body", "action", "parent_key", "sort_order",
      "active", "category", "image_url", "image_mode", "env", "version", "button_layout",
    ],
  },
  {
    resource: "messages",
    table: "smrtbot_messages",
    required: ["msg_key", "label", "text"],
    hasEnv: true,
    updatable: ["msg_key", "label", "text", "category", "buttons", "image_url", "image_mode", "env", "version"],
  },
  {
    resource: "missions",
    table: "smrtbot_missions",
    required: ["mission_id", "title"],
    hasEnv: true,
    orderBy: "sort_order",
    updatable: [
      "mission_id", "title", "mission_type", "content", "option_1", "option_2",
      "option_3", "correct_option", "reward_diamonds", "success_message",
      "related_video_id", "active", "sort_order", "env", "version",
    ],
  },
  {
    resource: "trivia",
    table: "smrtbot_trivia",
    required: ["video_id", "question", "option_1", "option_2"],
    hasEnv: true,
    updatable: ["video_id", "level", "question", "option_1", "option_2", "option_3", "correct_option", "source", "active", "env", "version"],
  },
  {
    resource: "raffles",
    table: "smrtbot_raffles",
    orderBy: "raffle_date",
    updatable: ["raffle_date", "hebrew_date", "status", "raffle_type", "winner_child_id", "coupon_code", "notes"],
  },
  {
    resource: "coupons",
    table: "smrtbot_coupons",
    required: ["coupon_code"],
    updatable: ["coupon_code", "description", "status", "raffle_type", "winner_child_id", "won_at", "notes"],
  },
  {
    resource: "children",
    table: "smrtbot_children",
    required: ["child_id"],
    updatable: ["child_id", "phone", "child_name", "hebrew_birthday", "reminder_time", "diamonds", "completed_items", "active_reminders"],
  },
  {
    resource: "knowledge",
    table: "smrtbot_knowledge_base",
    required: ["question_pattern", "answer"],
    hasEnv: true,
    orderBy: "sort_order",
    updatable: ["category", "question_pattern", "question", "keywords", "answer", "active", "notes", "sort_order", "env", "version"],
  },
  {
    resource: "auto-messages",
    table: "smrtbot_auto_messages",
    required: ["name", "content"],
    hasEnv: true,
    updatable: ["name", "msg_type", "wait_time", "unit", "content", "media_url", "active", "env", "version"],
  },
  {
    resource: "holidays",
    table: "smrtbot_holidays",
    required: ["holiday_name"],
    hasEnv: true,
    orderBy: "sort_order",
    updatable: ["holiday_name", "holiday_group", "hebrew_date", "start_date", "end_date", "active", "display_emoji", "sort_order", "notes", "env", "version"],
  },
  {
    resource: "scheduled",
    table: "smrtbot_scheduled_configs",
    required: ["name"],
    hasEnv: true,
    updatable: ["name", "active", "inactivity_minutes", "send_after_minutes", "body_text", "buttons", "image_url", "env"],
  },
  {
    resource: "feedback",
    table: "smrtbot_feedback",
    required: ["phone", "message"],
    updatable: ["phone", "message", "status", "admin_note"],
  },
  {
    resource: "phone-routes",
    table: "smrtbot_phone_routes",
    required: ["match_type", "match_value", "response_mode"],
    hasEnv: true,
    orderBy: "priority",
    updatable: [
      "label", "match_type", "match_value", "response_mode", "target_node_key",
      "reply_text", "reply_buttons", "priority", "active", "env",
    ],
  },
  {
    // Edit-only from the UI (readOnlyCreate): rows are engine-managed
    // (UNIQUE bot_id,phone), so admins tag/rename existing contacts here.
    resource: "contacts",
    table: "smrtbot_wa_users",
    orderBy: "created_at",
    updatable: ["name", "tags", "wa_opted_out"],
  },
  {
    // Tracking data (engine-managed). Admins can correct minutes/status.
    resource: "study-sessions",
    table: "smrtbot_study_sessions",
    orderBy: "started_at",
    updatable: ["status", "minutes"],
  },
  {
    resource: "prayers",
    table: "smrtbot_prayers",
    orderBy: "prayer_date",
    updatable: ["in_minyan", "minutes"],
  },
  {
    // AI project-manager data (engine-managed). Admins can rename/archive
    // projects and re-status entries.
    resource: "pm-projects",
    table: "smrtbot_pm_projects",
    orderBy: "entry_count",
    updatable: ["name", "description", "status"],
  },
  {
    resource: "pm-entries",
    table: "smrtbot_pm_entries",
    orderBy: "created_at",
    updatable: ["summary", "status"],
  },
  {
    resource: "questions",
    table: "smrtbot_questions",
    orderBy: "created_at",
    updatable: ["status", "needs_human", "admin_answer", "admin_reply", "send_reply", "reply_sent", "notes"],
  },
];

const router = Router();

for (const opts of CRUD) {
  router.use(makeCrudRouter(opts));
}

// ── Settings: key/value upsert (unique bot_id,key) ───────────
router.use("/bot/:botId/settings", requireBotAccess("botId"));

router.get("/bot/:botId/settings", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_settings")
    .select("*")
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .order("key");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ settings: data ?? [] });
});

router.put("/bot/:botId/settings/:key", async (req: Request, res: Response) => {
  const value = req.body?.value;
  if (typeof value !== "string") {
    return res.status(400).json({ error: "value (string) is required" });
  }
  const { data, error } = await db
    .from("smrtbot_settings")
    .upsert(
      {
        org_id: req.org!.id,
        bot_id: req.params.botId,
        key: req.params.key,
        value,
        description: typeof req.body?.description === "string" ? req.body.description : null,
      },
      { onConflict: "bot_id,key" },
    )
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ setting: data });
});

export default router;
