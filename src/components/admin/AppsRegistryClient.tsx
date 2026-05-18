"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, Plus, Pencil, Trash2, Loader2, ChevronRight } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

export type AppStage = "רעיון" | "בניה" | "טסט" | "מאור" | "לקוחות";

export const STAGE_COLORS: Record<AppStage, string> = {
  "רעיון":   "bg-gray-100   text-gray-600   border-gray-200",
  "בניה":    "bg-blue-50    text-blue-700   border-blue-200",
  "טסט":     "bg-amber-50   text-amber-700  border-amber-200",
  "מאור":    "bg-purple-50  text-purple-700 border-purple-200",
  "לקוחות": "bg-green-50   text-green-700  border-green-200",
};

interface AdminApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  org_count: number;
  stage: AppStage | null;
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

export function AppsRegistryClient() {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const { locale } = useParams() as { locale: string };
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminApp | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function fetchApps() {
    setLoading(true);
    try {
      const { apps } = await api<{ apps: AdminApp[] }>("/api/admin/apps", { noOrg: true });
      setApps(apps ?? []);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchApps(); }, []);

  function openCreate() {
    setEditing(null);
    setSlug(""); setName(""); setDescription("");
    setDialogOpen(true);
  }

  function openEdit(app: AdminApp) {
    setEditing(app);
    setSlug(app.slug); setName(app.name); setDescription(app.description ?? "");
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!editing && !SLUG_RE.test(slug)) {
      toast.error(t("slugError"));
      return;
    }
    if (!name.trim()) {
      toast.error(t("nameLabel") + " " + tCommon("error").toLowerCase());
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/admin/apps/${editing.slug}`, {
          method: "PATCH",
          body: { name: name.trim(), description: description.trim() },
          noOrg: true,
        });
        toast.success(t("appUpdated"));
      } else {
        await api("/api/admin/apps", {
          method: "POST",
          body: { slug, name: name.trim(), description: description.trim() || null },
          noOrg: true,
        });
        toast.success(t("appRegistered"));
      }
      setDialogOpen(false);
      fetchApps();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(app: AdminApp) {
    if (!confirm(t("unregisterConfirm", { name: app.name, count: app.org_count }))) return;
    try {
      await api(`/api/admin/apps/${app.slug}`, { method: "DELETE", noOrg: true });
      toast.success(t("appUnregistered"));
      fetchApps();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Layers className="h-6 w-6" />
          {t("appsRegistry")} <span className="text-muted-foreground text-base">({apps.length})</span>
        </h1>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t("registerNewApp")}
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : apps.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>{t("noAppsYet")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {apps.map((a) => (
            <Card key={a.id} className="hover:bg-accent/40 transition-colors">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <Link
                    href={`/${locale}/admin/apps/${a.slug}`}
                    className="flex items-center gap-2 min-w-0 flex-1 hover:underline"
                  >
                    <span className="truncate">{a.name}</span>
                    <span className="text-xs font-mono text-muted-foreground">{a.slug}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </Link>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(a)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500" onClick={() => handleDelete(a)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {a.description && (
                  <p className="text-xs text-muted-foreground mb-2">{a.description}</p>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  {a.stage && (
                    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${STAGE_COLORS[a.stage]}`}>
                      {a.stage}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {t("orgsEnabled", { count: a.org_count })}
                  </Badge>
                  <span className="ms-auto">{t("created")} {new Date(a.created_at).toLocaleDateString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t("editApp", { name: editing.name }) : t("registerNewApp")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">{t("slugLabel")}</label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder={t("slugPlaceholder")}
                disabled={!!editing}
                autoFocus={!editing}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {editing ? t("slugCannotChange") : t("slugFormat")}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium">{t("nameLabel")}</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
            </div>
            <div>
              <label className="text-xs font-medium">{t("descriptionOptional")}</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>{tCommon("cancel")}</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? tCommon("save") : t("register")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
