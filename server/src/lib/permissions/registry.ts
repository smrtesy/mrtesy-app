/**
 * Restrictable-resource catalog — BACKEND twin of `src/lib/permissions/registry.ts`.
 *
 * ⚠️ TWIN FILE — keep byte-for-byte in sync with the frontend copy at
 * `src/lib/permissions/registry.ts`. The two live in separate tsc builds (the
 * Express server can't import from the Next.js `src/` tree), exactly like
 * `rule-filters.ts` and its Deno twin. Any resource added/removed/renamed in
 * one must be mirrored in the other in the SAME commit.
 *
 * The backend uses this to (a) validate resource_key on writes and (b) resolve
 * a user's restricted set in `requireResource`. Labels are NOT here — they
 * resolve through the frontend i18n only.
 */

export type ResourceKind = "screen" | "subscreen" | "action";

export type RestrictableResource = {
  key: string;
  appSlug: string;
  kind: ResourceKind;
  labelKey: string;
  descriptionKey?: string;
  defaultRestricted: boolean;
  costly?: boolean;
  /** Whether the resource is actually enforced (guard + requireResource wired).
   *  false = catalog-only; the management UI disables it and the backend
   *  rejects a restrict toggle. Absent = true. */
  enforced?: boolean;
};

export const RESTRICTABLE_RESOURCES: RestrictableResource[] = [
  {
    key: "smrttask.screen.knowledge",
    appSlug: "smrttask",
    kind: "screen",
    labelKey: "permissions.resources.smrttask_screen_knowledge",
    descriptionKey: "permissions.resourceDesc.smrttask_screen_knowledge",
    defaultRestricted: false,
    enforced: true,
  },
  {
    key: "smrttask.screen.daily-report",
    appSlug: "smrttask",
    kind: "screen",
    labelKey: "permissions.resources.smrttask_screen_daily_report",
    descriptionKey: "permissions.resourceDesc.smrttask_screen_daily_report",
    defaultRestricted: false,
    enforced: true,
  },
  {
    key: "smrtcrm.screen.crm",
    appSlug: "smrtcrm",
    kind: "screen",
    labelKey: "permissions.resources.smrtcrm_screen_crm",
    descriptionKey: "permissions.resourceDesc.smrtcrm_screen_crm",
    defaultRestricted: false,
    enforced: false,
  },
  {
    key: "smrtstudio.action.run-paid",
    appSlug: "smrtstudio",
    kind: "action",
    labelKey: "permissions.resources.smrtstudio_action_run_paid",
    descriptionKey: "permissions.resourceDesc.smrtstudio_action_run_paid",
    defaultRestricted: false,
    costly: true,
    enforced: false,
  },
];

const BY_KEY = new Map(RESTRICTABLE_RESOURCES.map((r) => [r.key, r]));

export const RESOURCE_KEYS: ReadonlySet<string> = new Set(BY_KEY.keys());

export function getResource(key: string): RestrictableResource | undefined {
  return BY_KEY.get(key);
}

export function isValidResourceKey(key: string): boolean {
  return BY_KEY.has(key);
}
