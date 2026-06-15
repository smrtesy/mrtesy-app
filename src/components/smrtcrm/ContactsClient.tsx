"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Search, Mail, Phone, Loader2, Upload, Trash2, Tag as TagIcon, X } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { CsvImportDialog } from "@/components/smrtcrm/CsvImportDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
}

interface Tag {
  id: string;
  name: string;
}

const ALL_TAGS = "__all__";
const ALL_SEGMENTS = "__all__";
const emptyForm = { first_name: "", last_name: "", phone: "", email: "" };

export function ContactsClient() {
  const t = useTranslations("smrtCRM");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<Tag[]>([]);
  const [segments, setSegments] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>(ALL_TAGS);
  const [segmentFilter, setSegmentFilter] = useState<string>(ALL_SEGMENTS);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // When true the bulk action targets every contact matching the active filter,
  // not just the ids in `selected` (which only ever holds the loaded page).
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkTag, setBulkTag] = useState<string>(ALL_TAGS);

  // The filter currently applied to the list, in the shape the bulk API expects.
  const currentFilter = useCallback(() => {
    const f: Record<string, unknown> = {};
    if (search.trim()) f.q = search.trim();
    if (tagFilter !== ALL_TAGS) f.tag_id = tagFilter;
    if (segmentFilter !== ALL_SEGMENTS) f.segment_id = segmentFilter;
    return f;
  }, [search, tagFilter, segmentFilter]);

  const loadTags = useCallback(async () => {
    try {
      const [tagsRes, segsRes] = await Promise.all([
        api<{ tags: Tag[] }>("/api/crm/tags"),
        api<{ segments: Tag[] }>("/api/crm/segments"),
      ]);
      setTags(tagsRes.tags);
      setSegments(segsRes.segments);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      if (tagFilter !== ALL_TAGS) params.set("tag_id", tagFilter);
      if (segmentFilter !== ALL_SEGMENTS) params.set("segment_id", segmentFilter);
      const { contacts, total } = await api<{ contacts: Contact[]; total: number }>(
        `/api/crm/contacts?${params.toString()}`,
      );
      setContacts(contacts);
      setTotal(total);
      setSelected(new Set());
      setSelectAllMatching(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search, tagFilter, segmentFilter]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  useEffect(() => {
    const id = setTimeout(loadContacts, 250);
    return () => clearTimeout(id);
  }, [loadContacts]);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(c: Contact) {
    setEditingId(c.id);
    setForm({
      first_name: c.first_name ?? "",
      last_name: c.last_name ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.first_name.trim() && !form.phone.trim() && !form.email.trim()) {
      toast.error(t("addValidation"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
      };
      if (editingId) {
        await api(`/api/crm/contacts/${editingId}`, { method: "PATCH", body });
        toast.success(t("contactUpdated"));
      } else {
        const { outcome } = await api<{ outcome: "created" | "merged" }>("/api/crm/contacts", {
          method: "POST",
          body,
        });
        toast.success(outcome === "merged" ? t("addMerged") : t("addCreated"));
      }
      setDialogOpen(false);
      loadContacts();
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
      await api(`/api/crm/contacts/${editingId}`, { method: "DELETE" });
      toast.success(t("contactDeleted"));
      setDialogOpen(false);
      loadContacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function toggleSelect(id: string) {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOnPageSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id));

  function toggleSelectPage() {
    setSelectAllMatching(false);
    setSelected(allOnPageSelected ? new Set() : new Set(contacts.map((c) => c.id)));
  }

  function clearSelection() {
    setSelectAllMatching(false);
    setSelected(new Set());
  }

  // How many contacts the next bulk action will affect, and the body that targets them.
  const affectedCount = selectAllMatching ? total : selected.size;
  function bulkScope(): Record<string, unknown> {
    return selectAllMatching ? { filter: currentFilter() } : { contact_ids: [...selected] };
  }

  async function bulkAddTag() {
    if (bulkTag === ALL_TAGS || affectedCount === 0) return;
    try {
      await api("/api/crm/contacts/bulk", {
        method: "POST",
        body: { action: "add_tag", tag_id: bulkTag, ...bulkScope() },
      });
      toast.success(t("bulkTagged"));
      loadContacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function bulkDelete() {
    if (affectedCount === 0) return;
    if (!window.confirm(t("bulkDeleteConfirm"))) return;
    try {
      await api("/api/crm/contacts/bulk", {
        method: "POST",
        body: { action: "delete", ...bulkScope() },
      });
      toast.success(t("contactDeleted"));
      loadContacts();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function displayName(c: Contact): string {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    return name || c.phone || c.email || t("unnamed");
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="ps-9"
            />
          </div>
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={t("filterByTag")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TAGS}>{t("allTags")}</SelectItem>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {segments.length > 0 && (
            <Select value={segmentFilter} onValueChange={setSegmentFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={t("filterBySegment")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SEGMENTS}>{t("allSegments")}</SelectItem>
                {segments.map((seg) => (
                  <SelectItem key={seg.id} value={seg.id}>
                    {seg.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setImportOpen(true)} variant="outline" className="gap-2">
            <Upload className="h-4 w-4" />
            {t("importCsv")}
          </Button>
          <Button onClick={openAdd} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("addContact")}
          </Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 ? (
        <div className="space-y-2 rounded-lg border bg-accent/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {selectAllMatching
                ? t("allMatchingSelected", { count: total })
                : t("selectedCount", { count: selected.size })}
            </span>
            <Select value={bulkTag} onValueChange={setBulkTag}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue placeholder={t("filterByTag")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TAGS}>{t("chooseTag")}</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={bulkAddTag} disabled={bulkTag === ALL_TAGS} className="gap-1">
              <TagIcon className="h-4 w-4" />
              {t("bulkAddTag")}
            </Button>
            <Button size="sm" variant="outline" onClick={bulkDelete} className="gap-1 text-status-late">
              <Trash2 className="h-4 w-4" />
              {t("bulkDelete")}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection} className="gap-1 ms-auto">
              <X className="h-4 w-4" />
              {t("clearSelection")}
            </Button>
          </div>
          {/* Offer to extend selection from the loaded page to every match. */}
          {allOnPageSelected && total > contacts.length && (
            <button
              type="button"
              onClick={() => setSelectAllMatching((v) => !v)}
              className="text-sm font-medium text-primary underline-offset-2 hover:underline"
            >
              {selectAllMatching ? t("clearSelection") : t("selectAllMatching", { count: total })}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("totalCount", { count: total })}</p>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : contacts.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          {t("noContacts")}
        </div>
      ) : (
        <div className="rounded-lg border">
          <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2">
            <input
              type="checkbox"
              checked={allOnPageSelected}
              onChange={toggleSelectPage}
              aria-label={t("selectAll")}
              className="h-4 w-4 shrink-0 accent-primary"
            />
            <span className="text-sm text-muted-foreground">{t("selectAll")}</span>
          </div>
        <ul className="divide-y">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggleSelect(c.id)}
                aria-label={t("select")}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              <button
                type="button"
                onClick={() => openEdit(c)}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 text-start"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{displayName(c)}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
                    {c.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3.5 w-3.5" />
                        {c.phone}
                      </span>
                    )}
                    {c.email && (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3.5 w-3.5" />
                        {c.email}
                      </span>
                    )}
                  </div>
                </div>
                <Badge variant="secondary">{t(`source.${c.source}` as Parameters<typeof t>[0])}</Badge>
              </button>
            </li>
          ))}
        </ul>
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? t("editContact") : t("addContact")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <Input
                placeholder={t("firstName")}
                value={form.first_name}
                onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
              />
              <Input
                placeholder={t("lastName")}
                value={form.last_name}
                onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
              />
            </div>
            <Input
              placeholder={t("phone")}
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
            <Input
              placeholder={t("email")}
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <DialogFooter className="sm:justify-between">
            {editingId ? (
              <Button variant="ghost" onClick={handleDelete} disabled={saving} className="gap-1 text-status-late">
                <Trash2 className="h-4 w-4" />
                {t("deleteContact")}
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

      <CsvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        tags={tags}
        onImported={() => { loadContacts(); loadTags(); }}
      />
    </div>
  );
}
