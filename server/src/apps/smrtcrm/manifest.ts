import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtcrm",
  name: "smrtCRM",

  emits: [
    "contact.created",
    "contact.merged",
    "contact.updated",
    "contact.deleted",
    "tag.created",
    "group.created",
    "segment.created",
    "import.completed",
  ],

  // Cross-app event ingest:
  // - smrtBot emits contact.observed when a wa_user interacts (CRM-5) → upsert
  //   the contact + tag it with the bot's project tag.
  // - smrtReach emits contact.unsubscribed from its public unsubscribe page
  //   (CRM-6) → CRM flips email_unsubscribed on its own table. Neither app
  //   writes smrtCRM tables directly — the event is the seam.
  subscribes: [
    { event: "contact.observed", source: "smrtbot", handler: "handlers/onBotContact" },
    { event: "contact.unsubscribed", source: "smrtreach", handler: "handlers/onUnsubscribe" },
  ],

  notifications: {
    "import.completed": {
      type: "success",
      title: "ייבוא אנשי קשר הושלם",
      body: (p) =>
        `נוצרו ${String(p.created ?? 0)}, מוזגו ${String(p.merged ?? 0)}, דולגו ${String(p.skipped ?? 0)}`,
      link: "/crm",
    },
  },

  entities: {
    // Reads the source bot's name (for the project tag) when ingesting
    // contact.observed — declarative cross-app read, via the org-scoped client.
    reads: ["smrtbot_bots"],
    writes: [
      "smrtcrm_contacts",
      "smrtcrm_tags",
      "smrtcrm_tag_assignments",
      "smrtcrm_groups",
      "smrtcrm_group_members",
      "smrtcrm_segments",
      "smrtcrm_field_defs",
      "smrtcrm_api_connections",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: ["CSV import error", "Bot contact sync error", "Duplicate contact conflict"],
  },
};
