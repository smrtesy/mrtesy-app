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
    // this event (Reach-4 / CRM-6) — Reach never touches the contact's
    // preference fields itself.
    "contact.unsubscribed",
    // The public preferences page emits the chosen email_frequency tier back to
    // smrtCRM (granular all/weekly/monthly/none, botsite parity).
    "contact.preference_changed",
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
      "smrtcrm_tags",
      "smrtcrm_tag_assignments",
      // Gmail sending reuses the platform's per-user Google OAuth: the org's
      // members and their connected Gmail credentials (read-only).
      "org_members",
      "user_credentials",
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
      "smrtreach_gmail_quota",
      // Auto-tag on completion (botsite "קמפיין: <name>"): Reach creates/assigns
      // a CRM tag for the sent audience so it's reusable as a future audience.
      // Direct org-scoped write (same client audience-service reads with) — the
      // no-cross-app-*import* rule is honored; this is the declared exception.
      "smrtcrm_tags",
      "smrtcrm_tag_assignments",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: ["SES send failed", "smrtBot send-service unavailable", "Audience resolution error"],
  },
};
