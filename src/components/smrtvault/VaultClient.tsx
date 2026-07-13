"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Search, Loader2, Trash2, Upload, KeyRound, ExternalLink, ShieldCheck, X } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { VaultCsvImportDialog } from "@/components/smrtvault/VaultCsvImportDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface Credential {
  id: string;
  label: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const emptyForm = { label: "", username: "", url: "", notes: "", password: "" };

export function VaultClient() {
  const t = useTranslations("smrtVault");

  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const loadCredentials = useCallback(async () => {
    setLoading(true);
    try {
      const { credentials } = await api<{ credentials: Credential[] }>("/api/vault/credentials");
      setCredentials(credentials);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return credentials;
    return credentials.filter((c) =>
      [c.label, c.username, c.url].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [credentials, search]);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(c: Credential) {
    setEditingId(c.id);
    // The password is never returned to the browser; leaving it blank means
    // "keep the existing password" on save.
    setForm({
      label: c.label,
      username: c.username ?? "",
      url: c.url ?? "",
      notes: c.notes ?? "",
      password: "",
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.label.trim()) {
      toast.error(t("labelRequired"));
      return;
    }
    if (!editingId && !form.password) {
      toast.error(t("passwordRequired"));
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const body: Record<string, unknown> = {
          label: form.label.trim(),
          username: form.username.trim() || null,
          url: form.url.trim() || null,
          notes: form.notes.trim() || null,
        };
        if (form.password) body.password = form.password;
        await api(`/api/vault/credentials/${editingId}`, { method: "PATCH", body });
        toast.success(t("saved"));
      } else {
        await api("/api/vault/credentials", {
          method: "POST",
          body: {
            label: form.label.trim(),
            username: form.username.trim() || null,
            url: form.url.trim() || null,
            notes: form.notes.trim() || null,
            password: form.password,
          },
        });
        toast.success(t("saved"));
      }
      setDialogOpen(false);
      loadCredentials();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingId) return;
    if (!window.confirm(t("deleteConfirm"))) return;
    setSaving(true);
    try {
      await api(`/api/vault/credentials/${editingId}`, { method: "DELETE" });
      toast.success(t("deleted"));
      setDialogOpen(false);
      loadCredentials();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Security note: the app stores but never displays passwords. */}
      <div className="flex items-start gap-2 rounded-lg border bg-accent/40 px-3 py-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>{t("securityNote")}</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {searchOpen ? (
            <div className="relative w-56 max-w-full">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearchOpen(false); } }}
                placeholder={t("searchPlaceholder")}
                className="ps-9 pe-8"
              />
              <button
                type="button"
                onClick={() => { setSearch(""); setSearchOpen(false); }}
                aria-label={t("close")}
                className="absolute end-2 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => setSearchOpen(true)} aria-label={t("search")} title={t("search")}>
              <Search className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setImportOpen(true)} variant="outline" className="gap-2">
            <Upload className="h-4 w-4" />
            {t("importCsv")}
          </Button>
          <Button onClick={openAdd} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("add")}
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          {credentials.length === 0 ? t("empty") : t("noMatches")}
        </div>
      ) : (
        <div className="rounded-lg border">
          <ul className="divide-y">
            {filtered.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound className="h-5 w-5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => openEdit(c)}
                  className="flex min-w-0 flex-1 flex-col items-start text-start"
                >
                  <span className="truncate font-medium">{c.label}</span>
                  {c.username && (
                    <span className="truncate text-sm text-muted-foreground">{c.username}</span>
                  )}
                </button>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex shrink-0 items-center gap-1 text-sm text-primary hover:underline"
                    title={c.url}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t("open")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? t("editTitle") : t("addTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("fieldLabel")}</span>
              <Input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder={t("fieldLabelPlaceholder")}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("fieldUrl")}</span>
              <Input
                type="url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder={t("fieldUrlPlaceholder")}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("fieldUsername")}</span>
              <Input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder={t("fieldUsernamePlaceholder")}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">
                {editingId ? t("fieldPasswordEdit") : t("fieldPassword")}
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={editingId ? t("fieldPasswordEditPlaceholder") : t("fieldPasswordPlaceholder")}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{t("fieldNotes")}</span>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder={t("fieldNotesPlaceholder")}
              />
            </label>
          </div>
          <DialogFooter className="sm:justify-between">
            {editingId ? (
              <Button variant="ghost" onClick={handleDelete} disabled={saving} className="gap-1 text-status-late">
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                {t("cancel")}
              </Button>
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VaultCsvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => loadCredentials()}
      />
    </div>
  );
}
