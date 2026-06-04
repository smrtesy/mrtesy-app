import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtreach",
  name: "smrtReach",

  emits: [
    "campaign.created",
    "campaign.scheduled",
    "campaign.sending",
    "campaign.done",
    "campaign.failed",
    // The public unsubscribe page writes the preference back to smrtCRM via
    // this event (Reach-4 / CRM-6) — Reach never touches smrtCRM tables itself.
    "contact.unsubscribed",
  ],

  subscribes: [],

  notifications: {
    "campaign.done": {
      type: "success",
      title: (p) => `הקמפיין הסתיים: ${String(p.name ?? "")}`,
      body: (p) => `נשלחו ${String(p.sent ?? 0)} הודעות`,
      link: "/reach",
    },
    "campaign.failed": {
      type: "warning",
      title: (p) => `הקמפיין נכשל: ${String(p.name ?? "")}`,
      body: (p) => String(p.error ?? "שגיאה בשליחה"),
      link: "/reach",
    },
  },

  entities: {
    // Cross-app reads (declarative): Reach resolves audiences from smrtCRM.
    // The actual queries go through the org-scoped db client; no code import.
    reads: [
      "smrtcrm_contacts",
      "smrtcrm_segments",
      "smrtcrm_groups",
      "smrtcrm_group_members",
      "smrtcrm_tags",
      "smrtcrm_tag_assignments",
    ],
    writes: [
      "smrtreach_campaigns",
      "smrtreach_campaign_email",
      "smrtreach_campaign_whatsapp",
      "smrtreach_templates",
      "smrtreach_campaign_targets",
      "smrtreach_queue",
      "smrtreach_tracking",
      "smrtreach_logs",
      "smrtreach_senders",
      "smrtreach_settings",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: ["SES send failed", "smrtBot send-service unavailable", "Audience resolution error"],
  },
};
