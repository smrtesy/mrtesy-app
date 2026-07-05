import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtvoice",
  name: "smrtVoice",

  // Only events actually emitted via emitEvent() in this app. Kept in sync
  // with the emitEvent() call sites in routes.ts / webhook-handler.ts.
  emits: [
    "character.created",
    "character.deleted",
    "character.clone_created",
    "project.created",
    "project.deleted",
    "script.created",
    "script.archived",
    "job.queued",
    "audio.ready",
  ],

  subscribes: [],

  // No manifest-driven notifications: smrtVoice sends its user-facing
  // notifications directly (webhook-handler.ts) so they target the script's
  // creator and link to the live /voice/scripts/:id studio. A manifest entry
  // for "audio.ready" here previously double-notified the org owner with a
  // dead /voice/projects/:id/audio link.
  notifications: {},

  entities: {
    reads: [],
    writes: [
      "smrtvoice_characters",
      "smrtvoice_voice_profiles",
      "smrtvoice_projects",
      "smrtvoice_scripts",
      "smrtvoice_script_speakers",
      "smrtvoice_lines",
      "smrtvoice_jobs",
      "smrtvoice_voice_samples",
      "smrtvoice_voice_previews",
      "smrtvoice_voice_labels",
      "smrtvoice_pronunciation_lexicon",
      "smrtvoice_settings",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: [
      "Voice Engine unavailable",
      "Resemble API quota exceeded",
      "Failed to parse Google Doc",
      "Failed to clone voice",
    ],
  },
};
