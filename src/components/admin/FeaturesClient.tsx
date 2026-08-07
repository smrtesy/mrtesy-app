"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, ExternalLink, ChevronDown, ChevronRight, FlaskConical, Save, X } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { SITE_MAP } from "@/lib/site-map";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { toast } from "sonner";

interface FeatureVersion {
  version: string;
  date: string;
  summary: string;
  summaryHe?: string;
}

/** One row of GET /api/admin/features — registry STRUCTURE (incl. version list)
 *  merged with the feature_channels STATE (schema defaults where no row yet).
 *  Managed by version alone — no intent/promote_by/notes_url. */
interface FeatureChannel {
  feature_id: string;
  screen_key: string;
  title: string;
  title_he: string | null;
  code_ref: string;
  versions: FeatureVersion[];
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  note: string | null;
  last_changed_at: string | null;
  created_at: string | null;
  has_row: boolean;
}

/** The channel/version fields that stage as pending until "שמור". The note is
 *  saved separately (plain text, non-critical) and never enters this set. */
type PendingEdit = Partial<
  Pick<FeatureChannel, "stable_enabled" | "beta_enabled" | "stable_version" | "beta_version">
>;
const STAGED_KEYS: (keyof PendingEdit)[] = [
  "stable_enabled",
  "beta_enabled",
  "stable_version",
  "beta_version",
];

/** Flat path order from SITE_MAP so screen groups read top-to-bottom the same
 *  way the sidebar/site-map does. Unknown screens sort to the end. */
const SCREEN_ORDER: string[] = SITE_MAP.flatMap((s) => s.entries.map((e) => e.path));
function screenRank(path: string): number {
  const i = SCREEN_ORDER.indexOf(path);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export function FeaturesClient() {
  const [features, setFeatures] = useState<FeatureChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Staged, unsaved channel/version edits, keyed by feature_id. Only diffs vs
  // the saved value live here — an edit reverted to its saved value drops out.
  const [pending, setPending] = useState<Record<string, PendingEdit>>({});
  const [openDrawers, setOpenDrawers] = useState<Set<string>>(new Set());

  const pathname = usePathname();
  const locale = pathname.split("/")[1] || "he";

  const fetchFeatures = useCallback(async () => {
    setLoading(true);
    try {
      const { features } = await api<{ features: FeatureChannel[] }>(
        "/api/admin/features",
        { noOrg: true },
      );
      setFeatures(features ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFeatures(); }, [fetchFeatures]);

  /** Stage a channel/version change: merge into pending, then drop any field
   *  that now equals the saved value so `pending` reflects only real diffs
   *  (this is what makes reverting a toggle silently clear it from the bar). */
  const stage = useCallback((featureId: string, patch: PendingEdit) => {
    const base = features.find((f) => f.feature_id === featureId);
    if (!base) return;
    setPending((prev) => {
      const merged: PendingEdit = { ...prev[featureId], ...patch };
      const cleaned: PendingEdit = {};
      for (const k of STAGED_KEYS) {
        const mv = merged[k];
        if (mv !== undefined && mv !== base[k]) {
          (cleaned as Record<string, unknown>)[k] = mv;
        }
      }
      const next = { ...prev };
      if (Object.keys(cleaned).length) next[featureId] = cleaned;
      else delete next[featureId];
      return next;
    });
  }, [features]);

  const pendingCount = useMemo(
    () => Object.values(pending).reduce((n, p) => n + Object.keys(p).length, 0),
    [pending],
  );

  /** Save every pending feature (one PATCH each), then clear the bar. */
  async function saveAll() {
    const entries = Object.entries(pending);
    if (!entries.length) return;
    setSaving(true);
    try {
      for (const [featureId, patch] of entries) {
        const { feature } = await api<{ feature: Partial<FeatureChannel> }>(
          `/api/admin/features/${featureId}`,
          { method: "PATCH", noOrg: true, body: patch },
        );
        setFeatures((prev) =>
          prev.map((f) =>
            f.feature_id === featureId ? { ...f, ...feature, has_row: true } : f,
          ),
        );
        // Clear THIS feature from the bar as it lands, so a mid-loop failure
        // leaves only the still-unsaved features counted, not the applied ones.
        setPending((prev) => {
          const next = { ...prev };
          delete next[featureId];
          return next;
        });
      }
      toast.success("השינויים נשמרו וחלו");
    } catch (e) {
      toast.error((e as Error).message);
      fetchFeatures(); // re-sync so a rejected edit doesn't leave a stale toggle
    } finally {
      setSaving(false);
    }
  }

  /** Save the manual note immediately (separate from the staged bar). */
  async function saveNote(featureId: string, note: string) {
    try {
      const { feature } = await api<{ feature: Partial<FeatureChannel> }>(
        `/api/admin/features/${featureId}`,
        { method: "PATCH", noOrg: true, body: { note: note.trim() || null } },
      );
      setFeatures((prev) =>
        prev.map((f) =>
          f.feature_id === featureId ? { ...f, ...feature, has_row: true } : f,
        ),
      );
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

  // Group by screen_key, screens ordered by SITE_MAP.
  const groups = useMemo(() => {
    const byScreen = new Map<string, FeatureChannel[]>();
    for (const f of features) {
      const arr = byScreen.get(f.screen_key) ?? [];
      arr.push(f);
      byScreen.set(f.screen_key, arr);
    }
    return [...byScreen.entries()].sort((a, b) => screenRank(a[0]) - screenRank(b[0]));
  }, [features]);

  const effOf = useCallback(
    <K extends keyof PendingEdit>(f: FeatureChannel, key: K): FeatureChannel[K] => {
      const p = pending[f.feature_id];
      return (p && key in p ? (p[key] as FeatureChannel[K]) : f[key]);
    },
    [pending],
  );

  return (
    <div className="space-y-4 pb-8">
      {/* Sticky save bar — appears only when there are staged changes. */}
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
          <span className="text-base text-muted-foreground">({features.length})</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          שני ערוצים על אותה גרסה: <b>יציב</b> (לקוחות) ו-<b>בטא</b> (חנוך והצוות).
          כל שינוי חל מיד עם השמירה, בלי deploy.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : features.length === 0 ? (
        <div className="rounded-lg border py-12 text-center text-muted-foreground">
          <GitBranch className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>אין עדיין פיצ&apos;רים רשומים במרשם.</p>
        </div>
      ) : (
        groups.map(([screenKey, items]) => (
          <ScreenWindow
            key={screenKey}
            screenKey={screenKey}
            items={items}
            eff={effOf}
            onStage={stage}
            onSaveNote={saveNote}
            openDrawers={openDrawers}
            onToggleDrawer={toggleDrawer}
            pending={pending}
            locale={locale}
          />
        ))
      )}
    </div>
  );
}

/** One screen = one window: a header with a master toggle (turns every feature
 *  in the screen on/off at once), then a compact row per feature. */
function ScreenWindow({
  screenKey,
  items,
  eff,
  onStage,
  onSaveNote,
  openDrawers,
  onToggleDrawer,
  pending,
  locale,
}: {
  screenKey: string;
  items: FeatureChannel[];
  eff: <K extends keyof PendingEdit>(f: FeatureChannel, key: K) => FeatureChannel[K];
  onStage: (featureId: string, patch: PendingEdit) => void;
  onSaveNote: (featureId: string, note: string) => void;
  openDrawers: Set<string>;
  onToggleDrawer: (featureId: string) => void;
  pending: Record<string, PendingEdit>;
  locale: string;
}) {
  // Master toggle state: on only when EVERY channel of EVERY feature is on.
  const allOn = items.every((f) => eff(f, "stable_enabled") && eff(f, "beta_enabled"));
  const anyOn = items.some((f) => eff(f, "stable_enabled") || eff(f, "beta_enabled"));

  function toggleScreen() {
    const turnOn = !anyOn; // anything on → turn all off; nothing on → turn all on
    for (const f of items) {
      onStage(f.feature_id, { stable_enabled: turnOn, beta_enabled: turnOn });
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold">{screenKey}</span>
          <span className="text-xs text-muted-foreground">({items.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">הכל</span>
          <Switch
            checked={allOn}
            onCheckedChange={toggleScreen}
            aria-label="הדלק או כבה את כל הפיצ'רים במסך"
          />
        </div>
      </div>
      <div className="divide-y">
        {items.map((f) => (
          <FeatureRow
            key={f.feature_id}
            feature={f}
            eff={eff}
            onStage={onStage}
            onSaveNote={onSaveNote}
            open={openDrawers.has(f.feature_id)}
            onToggleOpen={() => onToggleDrawer(f.feature_id)}
            hasPending={Boolean(pending[f.feature_id] && Object.keys(pending[f.feature_id]).length)}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}

/** A compact one-line feature row: name · stable(toggle+version) ·
 *  beta(toggle+version) · open-screen · history/note drawer. */
function FeatureRow({
  feature: f,
  eff,
  onStage,
  onSaveNote,
  open,
  onToggleOpen,
  hasPending,
  locale,
}: {
  feature: FeatureChannel;
  eff: <K extends keyof PendingEdit>(f: FeatureChannel, key: K) => FeatureChannel[K];
  onStage: (featureId: string, patch: PendingEdit) => void;
  onSaveNote: (featureId: string, note: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  hasPending: boolean;
  locale: string;
}) {
  const [noteDraft, setNoteDraft] = useState(f.note ?? "");
  useEffect(() => { setNoteDraft(f.note ?? ""); }, [f.note]);

  const versionOpts = f.versions.map((v) => v.version);
  const showPicker = versionOpts.length > 1; // hide the picker for a single-version feature
  const noteChanged = (noteDraft.trim() || "") !== (f.note ?? "");

  return (
    <div className={hasPending ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <span className="min-w-[110px] flex-1 truncate text-sm font-medium" title={f.feature_id}>
          {f.title_he || f.title}
        </span>

        {/* Stable channel */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">יציב</span>
          <Switch
            checked={eff(f, "stable_enabled")}
            onCheckedChange={(v) => onStage(f.feature_id, { stable_enabled: v })}
            aria-label="הפעל בערוץ יציב"
          />
          {showPicker && (
            <VersionPicker
              value={eff(f, "stable_version")}
              options={versionOpts}
              onChange={(v) => onStage(f.feature_id, { stable_version: v })}
              label="גרסה בערוץ יציב"
            />
          )}
        </div>

        {/* Beta channel */}
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <FlaskConical className="h-3 w-3" /> בטא
          </span>
          <Switch
            checked={eff(f, "beta_enabled")}
            onCheckedChange={(v) => onStage(f.feature_id, { beta_enabled: v })}
            aria-label="הפעל בערוץ בטא"
          />
          {showPicker && (
            <VersionPicker
              value={eff(f, "beta_version")}
              options={versionOpts}
              onChange={(v) => onStage(f.feature_id, { beta_version: v })}
              label="גרסה בערוץ בטא"
            />
          )}
        </div>

        {/* Open the feature's screen in a new workspace tab */}
        <OpenTabLink
          href={`/${locale}${f.screen_key}`}
          label={f.title_he || f.title}
          title="פתח את המסך של הפיצ'ר"
          aria-label="פתח את המסך של הפיצ'ר"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </OpenTabLink>

        {/* History + note drawer toggle */}
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
        <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
          {/* Version history — newest first */}
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">היסטוריית גרסאות</p>
            <ul className="space-y-0.5">
              {[...f.versions].reverse().map((v) => (
                <li key={v.version} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">{v.date}</span>
                  <span className="font-mono font-semibold" dir="ltr">{v.version}</span>
                  <span>·</span>
                  <span>{v.summaryHe || v.summary}</span>
                </li>
              ))}
              {f.versions.length === 0 && (
                <li className="text-xs text-muted-foreground">אין היסטוריית גרסאות עדיין.</li>
              )}
            </ul>
          </div>

          {/* Manual note — saved separately from the staged bar */}
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
                onClick={() => onSaveNote(f.feature_id, noteDraft)}
                className="gap-1.5"
              >
                <Save className="h-3.5 w-3.5" /> שמור הערה
              </Button>
            </div>
          </div>

          <p className="font-mono text-[11px] text-muted-foreground">{f.code_ref}</p>
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
