import type { AppManifest } from "../../lib/platform/types";

/**
 * smrtDesign — generates unique design ideas via the built-in Claude engine,
 * guided by docs/design-process.md (the design method). It rides on the
 * `claude` console runner (repo access + browser-helper render loop, zero paid
 * API) rather than a new AI engine. See docs/smrtdesign-plan.md.
 */
export const manifest: AppManifest = {
  slug: "smrtdesign",
  name: "smrtDesign",

  // Only events actually emitted via emitEvent() in routes.ts. Keep in sync
  // with the emitEvent() call sites.
  emits: [
    "project.created",
    "design.generated",
    "design.locked",
  ],

  subscribes: [],

  // smrtDesign surfaces generation-done notifications directly (a run finishing
  // links to the project's gallery), so no manifest-driven notifications here.
  notifications: {},

  entities: {
    reads: [],
    writes: [
      "smrtdesign_projects",
      "smrtdesign_options",
      "smrtdesign_selections",
    ],
  },

  errors: {
    default_handler_role: "owner",
    examples: [
      "Design generation run failed",
      "Could not render an option",
      "Remix compose failed",
    ],
  },
};
