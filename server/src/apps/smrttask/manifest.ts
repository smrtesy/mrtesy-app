import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  // DB slug for the smrtTask app is "smrtesy" (legacy from when it was the only app).
  // The folder name "smrttask" remains for code organization clarity.
  slug: "smrtesy",
  name: "smrtTask",

  emits: [
    "task.created",
    "task.completed",
    "task.updated",
  ],

  subscribes: [],

  notifications: {
    // smrtTask does not emit platform notifications directly —
    // task suggestions surface through the tasks table (status=inbox).
    // Error notifications are emitted via notifyError() in the sync pipeline.
  },

  entities: {
    reads:  ["contacts"],
    writes: ["contacts"],
  },

  errors: {
    default_handler_role: "owner",
    examples: [
      "Gmail sync failed",
      "Drive API rate limit exceeded",
      "Classifier returned malformed JSON",
      "WhatsApp sheet unreadable",
    ],
  },
};
