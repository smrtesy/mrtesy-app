/**
 * Restrictable-resource catalog — the SINGLE SOURCE OF TRUTH for what can be
 * restricted across the platform.
 *
 * The permissions model is "open by default": within an app a member already
 * has, every screen/action is open UNLESS its key appears here AND the org has
 * marked it restricted (org_restrictions) AND the user has no exception
 * (user_resource_grants). See docs/permissions-management-plan.md.
 *
 * ⚠️ TWIN FILE — keep in sync with `server/src/lib/permissions/registry.ts`.
 * The backend can't import from `src/` (separate tsc build), so the catalog is
 * duplicated exactly like `rule-filters.ts` and its Deno twin. Any resource
 * added/removed/renamed here must be mirrored there in the SAME commit.
 *
 * Labels are NOT stored here — they resolve through i18n under
 * `permissions.resources.<key>` in src/messages/{he,en}.json.
 */

export type ResourceKind = "screen" | "subscreen" | "action";

export type RestrictableResource = {
  /** Stable, dotted, app-prefixed key, e.g. "smrttask.screen.knowledge". */
  key: string;
  /** The app this resource belongs to (its slug in the app registry). */
  appSlug: string;
  kind: ResourceKind;
  /** i18n key for the human label under `permissions.resources`. */
  labelKey: string;
  /** i18n key for a longer description (optional). */
  descriptionKey?: string;
  /**
   * Platform default when an org hasn't decided. Almost always false
   * (open-by-default). Super-admins can flip this in code.
   */
  defaultRestricted: boolean;
  /**
   * Marks a resource whose action spends money — the phase-2 "aim, don't run →
   * approve → auto-run" flow will key off this. Inert in phase 1.
   */
  costly?: boolean;
  /**
   * Whether this resource is actually ENFORCED yet — i.e. a `ResourceGuard`
   * wraps its screen AND a `requireResource` gates its API. `false` means it's
   * in the catalog for visibility but restricting it would be a no-op, so the
   * management UI shows it disabled ("coming soon") and the backend rejects a
   * restrict toggle. Absent = true.
   */
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

/** The set of every valid resource key (fast membership test). */
export const RESOURCE_KEYS: ReadonlySet<string> = new Set(BY_KEY.keys());

export function getResource(key: string): RestrictableResource | undefined {
  return BY_KEY.get(key);
}

export function isValidResourceKey(key: string): boolean {
  return BY_KEY.has(key);
}
