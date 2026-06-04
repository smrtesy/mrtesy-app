import type { AppManifest } from "../../lib/platform/types";

export const manifest: AppManifest = {
  slug: "smrtplan",
  name: "smrtPlan",

  emits: [
    "plan.created",
    "plan.updated",
    "task.unblocked", // a blocked task became ready after its inputs arrived
  ],

  // The planning engine listens for execution events from smrtTask: when a task
  // completes, release the dependents and advance the matrix (engine §2 ב).
  subscribes: [
    { event: "task.completed", source: "smrttask", handler: "on-task-completed" },
  ],

  notifications: {
    // Surfaced in-app on the board / task page rather than as platform toasts.
  },

  entities: {
    reads:  ["tasks", "projects"],
    writes: ["tasks"],
  },

  errors: {
    default_handler_role: "owner",
    examples: [
      "Backward scheduling hit a dependency cycle",
      "Plan deadline is before its earliest possible start",
      "Matrix cell references a deleted task",
    ],
  },
};
