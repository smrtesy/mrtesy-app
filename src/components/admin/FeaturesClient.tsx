"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, ExternalLink, ChevronDown, ChevronRight, FlaskConical, Save, X } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { SITE_MAP } from "@/lib/site-map";
import { FEATURE_REGISTRY, type FeatureVersion } from "@/lib/feature-registry";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { toast } from "sonner";

/** Raw feature_channels STATE row from GET /api/admin/features. */
interface FeatureChannelRow {
  feature_id: string;
  screen_key: string;
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  note: string | null;
  last_changed_at: string | null;
  created_at: string | null;
}

/** One manageable unit in the screen — either a whole SCREEN (from SITE_MAP,
 *  feature_id = its path) or a SUB-FEATURE inside a screen (from the code
 *  registry). STRUCTURE (title/versions/code_ref/isScreen) merged with the
 *  effective STATE (row value, or the schema/registry default when rowless). */
interface Cell {
  feature_id: string;
  screen_key: string;
  title: string;            // resolved for display
  code_ref: string | null;
  versions: FeatureVersion[];
  isScreen: boolean;
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  note: string | null;
  created_at: string | null;
  has_row: boolean;
}

/** Channel/version fields that stage as pending until "שמור". Note saves
 *  separately (plain text, non-critical). */
type PendingEdit = Partial<
  Pick<Cell, "stable_enabled" | "beta_enabled" | "stable_version" | "beta_version">
>;
const STAGED_KEYS: (keyof PendingEdit)[] = [
  "stable_enabled",
  "beta_enabled",
  "stable_version",
  "beta_version",
];

/** A screen's feature_id — a URL-safe, dotted id derived from its path, NOT the
 *  raw path (a path starts with "/" and can contain more, which would break the
 *  PATCH URL /admin/features/:featureId). "/tasks" → "tasks",
 *  "/whatsapp/autoreply" → "whatsapp.autoreply". This mirrors the dotted
 *  sub-feature convention ("day-tools.focus-plan"), and the channel gate (step 2)
 *  will derive the same id from a path. screen_key stays the real path. */
function screenIdFromPath(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, ".");
}

function defaultCellState(
  row: FeatureChannelRow | undefined,
  versions: FeatureVersion[],
): Pick<Cell, "stable_enabled" | "beta_enabled" | "stable_version" | "beta_version" | "note" | "created_at" | "has_row"> {
  return {
    stable_enabled: row?.stable_enabled ?? false,
    beta_enabled: row?.beta_enabled ?? true,
    stable_version: row?.stable_version ?? (versions[0]?.version ?? "v1"),
    beta_version: row?.beta_version ?? (versions[versions.length - 1]?.version ?? "v1"),
    note: row?.note ?? null,
    created_at: row?.created_at ?? null,
    has_row: Boolean(row),
  };
}

export function FeaturesClient() {
  const t = useTranslations();
  const [rows, setRows] = useState<FeatureChannelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Staged, unsaved channel/version edits keyed by feature_id (only real diffs).
  const [pending, setPending] = useState<Record<string, PendingEdit>>({});
  const [openDrawers, setOpenDrawers] = useState<Set<string>>(new Set());

  const pathname = usePathname();
  const locale = pathname.split("/")[1] || "he";

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const { rows } = await api<{ rows: FeatureChannelRow[] }>(
        "/api/admin/features",
        { noOrg: true },
      );
      setRows(rows ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const rowsById = useMemo(() => {
    const m = new Map<string, FeatureChannelRow>();
    for (const r of rows) m.set(r.feature_id, r);
    return m;
  }, [rows]);

  // Assemble STRUCTURE (SITE_MAP app screens + registry sub-features) × STATE.
  // Only app sections are channel-gated; platform/admin screens are not listed.
  const groups = useMemo(() => {
    return SITE_MAP.filter((s) => s.appSlug).map((section) => ({
      appSlug: section.appSlug as string,
      screens: section.entries.map((entry) => {
        const screenCell: Cell = {
          feature_id: screenIdFromPath(entry.path),
          screen_key: entry.path,
          title: t(entry.labelKey as Parameters<typeof t>[0]),
          code_ref: null,
          versions: [],
          isScreen: true,
          ...defaultCellState(rowsById.get(entry.path), []),
        };
        const subs: Cell[] = FEATURE_REGISTRY.filter((f) => f.screenKey === entry.path).map((f) => {
          const versions = f.versions ?? [];
          return {
            feature_id: f.featureId,
            screen_key: f.screenKey,
            title: f.titleHe || f.title,
            code_ref: f.codeRef,
            versions,
            isScreen: false,
            ...defaultCellState(rowsById.get(f.featureId), versions),
          };
        });
        return { entry, screenCell, subs };
      }),
    }));
  }, [rowsById, t]);

  /** Stage a channel/version change for a cell; drop fields reverted to their
   *  saved value so the bar counts only real diffs. `base` is the cell's saved
   *  state (from rows), reconstructed the same way the view builds it. */
  const stage = useCallback((cell: Cell, patch: PendingEdit) => {
    const saved = defaultCellState(rowsById.get(cell.feature_id), cell.versions);
    setPending((prev) => {
      const merged: PendingEdit = { ...prev[cell.feature_id], ...patch };
      const cleaned: PendingEdit = {};
      for (const k of STAGED_KEYS) {
        const mv = merged[k];
        if (mv !== undefined && mv !== saved[k]) {
          (cleaned as Record<string, unknown>)[k] = mv;
        }
      }
      const next = { ...prev };
      if (Object.keys(cleaned).length) next[cell.feature_id] = cleaned;
      else delete next[cell.feature_id];
      return next;
    });
  }, [rowsById]);

  const pendingCount = useMemo(
    () => Object.values(pending).reduce((n, p) => n + Object.keys(p).length, 0),
    [pending],
  );

  /** Effective value = staged override, else saved cell value. */
  const effOf = useCallback(
    <K extends keyof PendingEdit>(cell: Cell, key: K): Cell[K] => {
      const p = pending[cell.feature_id];
      return (p && key in p ? (p[key] as Cell[K]) : cell[key]);
    },
    [pending],
  );

  /** All cells (screens + subs) flattened, for the save loop's lookup. */
  const cellById = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const g of groups) for (const s of g.screens) {
      m.set(s.screenCell.feature_id, s.screenCell);
      for (const c of s.subs) m.set(c.feature_id, c);
    }
    return m;
  }, [groups]);

  /** Save every pending cell (one PATCH each) — always send screen_key + title
   *  so a first write (a screen with no row yet) can insert its identity. */
  async function saveAll() {
    const entries = Object.entries(pending);
    if (!entries.length) return;
    setSaving(true);
    try {
      for (const [featureId, patch] of entries) {
        const cell = cellById.get(featureId);
        const body = {
          ...patch,
          screen_key: cell?.screen_key ?? featureId,
          title: cell?.title ?? featureId,
        };
        const { feature } = await api<{ feature: FeatureChannelRow }>(
          `/api/admin/features/${encodeURIComponent(featureId)}`,
          { method: "PATCH", noOrg: true, body },
        );
        // Fold the saved row back into rows so the base updates.
        setRows((prev) => {
          const others = prev.filter((r) => r.feature_id !== featureId);
          return feature ? [...others, feature] : others;
        });
        setPending((prev) => {
          const next = { ...prev };
          delete next[featureId];
          return next;
        });
      }
      toast.success("השינויים נשמרו וחלו");
    } catch (e) {
      toast.error((e as Error).message);
      fetchRows();
    } finally {
      setSaving(false);
    }
  }

  /** Save a cell's manual note immediately (separate from the staged bar). */
  async function saveNote(cell: Cell, note: string) {
    try {
      const { feature } = await api<{ feature: FeatureChannelRow }>(
        `/api/admin/features/${encodeURIComponent(cell.feature_id)}`,
        {
          method: "PATCH",
          noOrg: true,
          body: { note: note.trim() || null, screen_key: cell.screen_key, title: cell.title },
        },
      );
      setRows((prev) => {
        const others = prev.filter((r) => r.feature_id !== cell.feature_id);
        return feature ? [...others, feature] : others;
      });
      toast.success("ההערה נשמרה");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function toggleDrawer(featureId: string) {
    setOpenDrawers((prev) => {
      const next = new Set(prev);
      if (next.has(featureId)) next.delete(featureId);
      else next.add(featureId);
      return next;
    });
  }

  const screenCount = groups.reduce((n, g) => n + g.screens.length, 0);

  return (
    <div className="space-y-4 pb-8">
      {pendingCount > 0 && (
        <div className="sticky top-0 z-20 -mx-1 flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 shadow-sm dark:border-amber-800 dark:bg-amber-950/40">
          <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {pendingCount} שינויים לא נשמרו — יחולו רק בלחיצת שמירה
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending({})} disabled={saving} className="gap-1.5">
              <X className="h-3.5 w-3.5" /> בטל
            </Button>
            <Button size="sm" onClick={saveAll} disabled={saving} className="gap-1.5">
              <Save className="h-3.5 w-3.5" /> שמור
            </Button>
          </div>
        </div>
      )}

      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <GitBranch className="h-6 w-6" />
          ערוצי-בשלות
          <span className="text-base text-muted-foreground">({screenCount} מסכים)</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          שני ערוצים על אותה גרסה: <b>יציב</b> (לקוחות) ו-<b>בטא</b> (חנוך והצוות).
          כל שינוי חל עם השמירה, בלי deploy.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : (
        groups.map((group) => (
          <div key={group.appSlug} className="overflow-hidden rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2">
              <span className="font-mono text-xs font-semibold uppercase tracking-wide">{group.appSlug}</span>
            </div>
            <div className="divide-y">
              {group.screens.map(({ entry, screenCell, subs }) => (
                <div key={entry.path}>
                  <FeatureRow
                    cell={screenCell}
                    eff={effOf}
                    onStage={stage}
                    onSaveNote={saveNote}
                    open={openDrawers.has(screenCell.feature_id)}
                    onToggleOpen={() => toggleDrawer(screenCell.feature_id)}
                    hasPending={Boolean(pending[screenCell.feature_id])}
                    locale={locale}
                    showOpen
                  />
                  {subs.map((c) => (
                    <FeatureRow
                      key={c.feature_id}
                      cell={c}
                      eff={effOf}
                      onStage={stage}
                      onSaveNote={saveNote}
                      open={openDrawers.has(c.feature_id)}
                      onToggleOpen={() => toggleDrawer(c.feature_id)}
                      hasPending={Boolean(pending[c.feature_id])}
                      locale={locale}
                      indented
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** A compact one-line row: name · stable(toggle+version) · beta(toggle+version)
 *  · open-screen · history/note drawer. Used for both screen-level cells (bold,
 *  with the open-screen button) and indented sub-feature cells. */
function FeatureRow({
  cell,
  eff,
  onStage,
  onSaveNote,
  open,
  onToggleOpen,
  hasPending,
  locale,
  showOpen,
  indented,
}: {
  cell: Cell;
  eff: <K extends keyof PendingEdit>(cell: Cell, key: K) => Cell[K];
  onStage: (cell: Cell, patch: PendingEdit) => void;
  onSaveNote: (cell: Cell, note: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  hasPending: boolean;
  locale: string;
  showOpen?: boolean;
  indented?: boolean;
}) {
  const [noteDraft, setNoteDraft] = useState(cell.note ?? "");
  useEffect(() => { setNoteDraft(cell.note ?? ""); }, [cell.note]);

  const versionOpts = cell.versions.map((v) => v.version);
  const showPicker = versionOpts.length > 1;
  const noteChanged = (noteDraft.trim() || "") !== (cell.note ?? "");

  return (
    <div className={hasPending ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 ${indented ? "ps-8" : ""}`}>
        <span
          className={`min-w-[110px] flex-1 truncate text-sm ${cell.isScreen ? "font-semibold" : ""}`}
          title={cell.feature_id}
        >
          {indented && <span className="text-muted-foreground">↳ </span>}
          {cell.title}
        </span>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">יציב</span>
          <Switch
            checked={eff(cell, "stable_enabled")}
            onCheckedChange={(v) => onStage(cell, { stable_enabled: v })}
            aria-label="הפעל בערוץ יציב"
          />
          {showPicker && (
            <VersionPicker
              value={eff(cell, "stable_version")}
              options={versionOpts}
              onChange={(v) => onStage(cell, { stable_version: v })}
              label="גרסה בערוץ יציב"
            />
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <FlaskConical className="h-3 w-3" /> בטא
          </span>
          <Switch
            checked={eff(cell, "beta_enabled")}
            onCheckedChange={(v) => onStage(cell, { beta_enabled: v })}
            aria-label="הפעל בערוץ בטא"
          />
          {showPicker && (
            <VersionPicker
              value={eff(cell, "beta_version")}
              options={versionOpts}
              onChange={(v) => onStage(cell, { beta_version: v })}
              label="גרסה בערוץ בטא"
            />
          )}
        </div>

        {showOpen && (
          <OpenTabLink
            href={`/${locale}${cell.screen_key}`}
            label={cell.title}
            title="פתח את המסך"
            aria-label="פתח את המסך"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </OpenTabLink>
        )}

        <button
          type="button"
          onClick={onToggleOpen}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="היסטוריית גרסאות והערה"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>

      {open && (
        <div className={`space-y-3 border-t bg-muted/20 px-3 py-3 ${indented ? "ps-8" : ""}`}>
          {cell.versions.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">היסטוריית גרסאות</p>
              <ul className="space-y-0.5">
                {[...cell.versions].reverse().map((v) => (
                  <li key={v.version} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">{v.date}</span>
                    <span className="font-mono font-semibold" dir="ltr">{v.version}</span>
                    <span>·</span>
                    <span>{v.summaryHe || v.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">הערה</p>
            <div className="flex items-start gap-2">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="הערה חופשית — נשמרת בנפרד"
                rows={2}
                className="flex-1 rounded border bg-background px-2 py-1 text-sm"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!noteChanged}
                onClick={() => onSaveNote(cell, noteDraft)}
                className="gap-1.5"
              >
                <Save className="h-3.5 w-3.5" /> שמור הערה
              </Button>
            </div>
          </div>

          {cell.code_ref && (
            <p className="font-mono text-[11px] text-muted-foreground">{cell.code_ref}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact native version dropdown (LTR — versions are v1/v2/…). */
function VersionPicker({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      dir="ltr"
      className="h-7 rounded border bg-background px-1 text-xs"
    >
      {options.map((v) => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  );
}
