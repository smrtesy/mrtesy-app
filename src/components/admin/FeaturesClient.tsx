"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, ArrowUpCircle, FlaskConical, Link2 } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { SITE_MAP } from "@/lib/site-map";
import { toast } from "sonner";

type FeatureIntent = "fork" | "migrate";

/** One row of GET /api/admin/features — registry STRUCTURE merged with the
 *  feature_channels STATE (schema defaults where no row exists yet). */
interface FeatureChannel {
  feature_id: string;
  screen_key: string;
  title: string;
  title_he: string | null;
  code_ref: string;
  has_versions: boolean;
  stable_enabled: boolean;
  beta_enabled: boolean;
  stable_version: string;
  beta_version: string;
  intent: FeatureIntent;
  promote_by: string | null;
  notes_url: string | null;
  last_changed_at: string | null;
  created_at: string | null;
  has_row: boolean;
}

/** Flat path order from SITE_MAP so screen groups read top-to-bottom the same
 *  way the sidebar/site-map does. Unknown screens sort to the end. */
const SCREEN_ORDER: string[] = SITE_MAP.flatMap((s) => s.entries.map((e) => e.path));
function screenRank(path: string): number {
  const i = SCREEN_ORDER.indexOf(path);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** "כמה זמן בבטא" — whole days since the row was first created. */
function daysInBeta(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

export function FeaturesClient() {
  const [features, setFeatures] = useState<FeatureChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function fetchFeatures() {
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
  }

  useEffect(() => { fetchFeatures(); }, []);

  /** Patch one feature and fold the returned row back into local state. The
   *  server returns the feature_channels row; we keep the registry-only fields
   *  (code_ref/has_versions) from the current object. Runs immediately — no deploy. */
  async function patchFeature(featureId: string, patch: Partial<FeatureChannel>) {
    setBusyId(featureId);
    try {
      const { feature } = await api<{ feature: Partial<FeatureChannel> }>(
        `/api/admin/features/${featureId}`,
        { method: "PATCH", noOrg: true, body: patch },
      );
      setFeatures((prev) =>
        prev.map((f) =>
          f.feature_id === featureId ? { ...f, ...feature, has_row: true } : f,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
      // Re-sync from the server so a rejected edit doesn't leave a stale toggle.
      fetchFeatures();
    } finally {
      setBusyId(null);
    }
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GitBranch className="h-6 w-6" />
          ערוצי-בשלות
          <span className="text-muted-foreground text-base">({features.length})</span>
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">
        שני ערוצים על גבי אותה גרסה: <b>יציב</b> (לקוחות) ו-<b>בטא</b> (חנוך והצוות).
        כל שינוי כאן נכנס לתוקף מיד, בלי deploy.
      </p>

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : features.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>אין עדיין פיצ&apos;רים רשומים במרשם.</p>
          </CardContent>
        </Card>
      ) : (
        groups.map(([screenKey, items]) => (
          <div key={screenKey} className="space-y-2">
            <h2 className="text-xs font-mono font-semibold text-muted-foreground px-1">
              {screenKey}
            </h2>
            {items.map((f) => (
              <FeatureRow
                key={f.feature_id}
                feature={f}
                busy={busyId === f.feature_id}
                onPatch={(patch) => patchFeature(f.feature_id, patch)}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function FeatureRow({
  feature: f,
  busy,
  onPatch,
}: {
  feature: FeatureChannel;
  busy: boolean;
  onPatch: (patch: Partial<FeatureChannel>) => void;
}) {
  // Local text drafts so typing doesn't fire a request per keystroke; commit onBlur.
  const [stableVer, setStableVer] = useState(f.stable_version);
  const [betaVer, setBetaVer] = useState(f.beta_version);
  const [promoteBy, setPromoteBy] = useState(f.promote_by ?? "");
  const [notesUrl, setNotesUrl] = useState(f.notes_url ?? "");

  useEffect(() => { setStableVer(f.stable_version); }, [f.stable_version]);
  useEffect(() => { setBetaVer(f.beta_version); }, [f.beta_version]);
  useEffect(() => { setPromoteBy(f.promote_by ?? ""); }, [f.promote_by]);
  useEffect(() => { setNotesUrl(f.notes_url ?? ""); }, [f.notes_url]);

  const days = daysInBeta(f.created_at);

  return (
    <Card className={busy ? "opacity-60 pointer-events-none" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate">{f.title_he || f.title}</span>
            <span className="text-xs font-mono text-muted-foreground">{f.feature_id}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {days === null ? "טרם נוצר" : `${days} ימים בבטא`}
            </Badge>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-[11px] font-mono text-muted-foreground">{f.code_ref}</p>

        {/* Two channels side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Stable */}
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">יציב (לקוחות)</span>
              <Switch
                checked={f.stable_enabled}
                onCheckedChange={(v) => onPatch({ stable_enabled: v })}
                aria-label="הפעל בערוץ יציב"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-14">גרסה</span>
              <Input
                value={stableVer}
                onChange={(e) => setStableVer(e.target.value)}
                onBlur={() => stableVer.trim() && stableVer !== f.stable_version && onPatch({ stable_version: stableVer.trim() })}
                className="h-7 text-sm"
                dir="ltr"
              />
            </div>
          </div>

          {/* Beta */}
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium flex items-center gap-1">
                <FlaskConical className="h-3.5 w-3.5" /> בטא (צוות)
              </span>
              <Switch
                checked={f.beta_enabled}
                onCheckedChange={(v) => onPatch({ beta_enabled: v })}
                aria-label="הפעל בערוץ בטא"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-14">גרסה</span>
              <Input
                value={betaVer}
                onChange={(e) => setBetaVer(e.target.value)}
                onBlur={() => betaVer.trim() && betaVer !== f.beta_version && onPatch({ beta_version: betaVer.trim() })}
                className="h-7 text-sm"
                dir="ltr"
              />
            </div>
          </div>
        </div>

        {/* Intent + promote_by + notes_url */}
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium mb-1">כוונה</p>
            <div className="flex gap-1">
              {(["fork", "migrate"] as FeatureIntent[]).map((opt) => (
                <button
                  key={opt}
                  onClick={() => opt !== f.intent && onPatch({ intent: opt })}
                  className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${
                    f.intent === opt
                      ? "bg-accent text-primary border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-foreground"
                  }`}
                >
                  {opt === "fork" ? "פיצול (fork)" : "החלפה (migrate)"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium mb-1">קדם עד (migrate)</p>
            <Input
              type="date"
              value={promoteBy}
              onChange={(e) => setPromoteBy(e.target.value)}
              onBlur={() => (promoteBy || null) !== f.promote_by && onPatch({ promote_by: promoteBy || null })}
              className="h-7 text-sm w-40"
              dir="ltr"
            />
          </div>

          <div className="flex-1 min-w-[180px]">
            <p className="text-xs font-medium mb-1 flex items-center gap-1">
              <Link2 className="h-3 w-3" /> קישור להסבר השינויים
            </p>
            <Input
              value={notesUrl}
              onChange={(e) => setNotesUrl(e.target.value)}
              onBlur={() => (notesUrl.trim() || null) !== f.notes_url && onPatch({ notes_url: notesUrl.trim() || null })}
              placeholder="https://…"
              className="h-7 text-sm"
              dir="ltr"
            />
          </div>

          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8"
            disabled={f.stable_enabled}
            onClick={() => onPatch({ stable_enabled: true })}
          >
            <ArrowUpCircle className="h-3.5 w-3.5" />
            קדם לרזה
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
