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

  // smrtCRM ingests bot contacts via an event from smrtBot (CRM-5). The
  // exact event name is finalized when smrtBot is built; wire it here then.
  //
  // It also owns email preferences (CRM-6): when smrtReach's public
  // unsubscribe page emits contact.unsubscribed, CRM flips the flag on its
  // own table — Reach never writes smrtCRM directly.
  subscribes: [
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
    reads: [],
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
