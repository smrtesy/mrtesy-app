"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api/client";
import { toast } from "sonner";

interface AdminApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  org_count: number;
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

export function AppsRegistryClient() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loading, setLoading] = useState(true);

  // Register/edit dialog state
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
      toast.error("Slug must be lowercase letters/numbers/dashes, 2–40 chars, starting with a letter");
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required");
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
        toast.success("App updated");
      } else {
        await api("/api/admin/apps", {
          method: "POST",
          body: { slug, name: name.trim(), description: description.trim() || null },
          noOrg: true,
        });
        toast.success("App registered");
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
    if (!confirm(`Unregister "${app.name}"? This will revoke access for ALL ${app.org_count} org${app.org_count === 1 ? "" : "s"} currently using it.`)) return;
    try {
      await api(`/api/admin/apps/${app.slug}`, { method: "DELETE", noOrg: true });
      toast.success("App unregistered");
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
          Apps Registry <span className="text-muted-foreground text-base">({apps.length})</span>
        </h1>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Register new app
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : apps.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No apps yet — register the first one.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {apps.map((a) => (
            <Card key={a.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{a.name}</span>
                    <span className="text-xs font-mono text-muted-foreground">{a.slug}</span>
                  </div>
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
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="text-[10px]">
                    {a.org_count} org{a.org_count === 1 ? "" : "s"} enabled
                  </Badge>
                  <span className="ms-auto">created {new Date(a.created_at).toLocaleDateString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Register / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit "${editing.name}"` : "Register new app"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Slug</label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="e.g. crm"
                disabled={!!editing}
                autoFocus={!editing}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {editing ? "Slug cannot be changed after registration." : "Lowercase letters, numbers, dashes. 2–40 chars."}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM" />
            </div>
            <div>
              <label className="text-xs font-medium">Description (optional)</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this app do?"
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
