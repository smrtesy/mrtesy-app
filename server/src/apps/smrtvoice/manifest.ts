import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtvoice",
  name: "smrtVoice",

  emits: [
    "character.created",
    "character.clone_created",
    "project.created",
    "project.script_imported",
    "project.completed",
    "project.archived",
    "job.queued",
    "job.started",
    "job.completed",
    "job.failed",
    "audio.ready",
    "line.completed",
    "line.failed",
  ],

  subscribes: [],

  notifications: {
    "audio.ready": {
      type: "success",
      title: (p) => `האודיו מוכן: ${String(p.project_name ?? "פרויקט")}`,
      body: (p) =>
        `${String(p.lines_completed ?? 0)} שורות, עלות: $${Number(
          p.total_cost_usd ?? 0,
        ).toFixed(2)}`,
      link: (p) => `/voice/projects/${String(p.project_id ?? "")}/audio`,
    },
    "job.failed": {
      type: "warning",
      title: (p) => `ייצור נכשל: ${String(p.project_name ?? "פרויקט")}`,
      body: (p) => String(p.error ?? "בעיה בייצור הקול"),
      link: (p) => `/voice/projects/${String(p.project_id ?? "")}`,
    },
    "project.completed": {
      type: "info",
      title: (p) => `הפרויקט הושלם: ${String(p.name ?? "")}`,
      link: (p) => `/voice/projects/${String(p.project_id ?? "")}`,
    },
  },

  entities: {
    reads: [],
    writes: [
      "smrtvoice_characters",
      "smrtvoice_voice_profiles",
      "smrtvoice_projects",
      "smrtvoice_lines",
      "smrtvoice_jobs",
      "smrtvoice_voice_samples",
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
