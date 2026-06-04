"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, Loader2 } from "lucide-react";

import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Named { id: string; name: string }
interface Segment { id: string; name: string }

const ANY = "__any__";

export function CrmManagePanel() {
  const t = useTranslations("smrtCRM");

  const [tags, setTags] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);

  const [newTag, setNewTag] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [segName, setSegName] = useState("");
  const [segTag, setSegTag] = useState<string>(ANY);
  const [segHasEmail, setSegHasEmail] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tagsRes, groupsRes, segsRes] = await Promise.all([
        api<{ tags: Named[] }>("/api/crm/tags"),
        api<{ groups: Named[] }>("/api/crm/groups"),
        api<{ segments: Segment[] }>("/api/crm/segments"),
      ]);
      setTags(tagsRes.tags);
      setGroups(groupsRes.groups);
      setSegments(segsRes.segments);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createTag() {
    if (!newTag.trim()) return;
    setBusy(true);
    try {
      await api("/api/crm/tags", { method: "POST", body: { name: newTag.trim() } });
      setNewTag("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function createGroup() {
    if (!newGroup.trim()) return;
    setBusy(true);
    try {
      await api("/api/crm/groups", { method: "POST", body: { name: newGroup.trim() } });
      setNewGroup("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function createSegment() {
    if (!segName.trim()) return;
    setBusy(true);
    try {
      const filter: Record<string, unknown> = {};
      if (segTag !== ANY) filter.tag_id = segTag;
      if (segHasEmail) filter.has_email = true;
      await api("/api/crm/segments", { method: "POST", body: { name: segName.trim(), filter } });
      setSegName(""); setSegTag(ANY); setSegHasEmail(false);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove(kind: "tags" | "groups" | "segments", id: string) {
    try {
      await api(`/api/crm/${kind}/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 rounded-lg border p-5 lg:grid-cols-3">
      {/* Tags */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("tagsTitle")}</h2>
        <div className="flex gap-2">
          <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder={t("newName")} />
          <Button size="icon" onClick={createTag} disabled={busy} aria-label={t("addBtn")}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ManagedList items={tags} empty={t("noTags")} onDelete={(id) => remove("tags", id)} deleteLabel={t("deleteBtn")} />
      </section>

      {/* Groups */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("groupsTitle")}</h2>
        <div className="flex gap-2">
          <Input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder={t("newName")} />
          <Button size="icon" onClick={createGroup} disabled={busy} aria-label={t("addBtn")}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ManagedList items={groups} empty={t("noGroups")} onDelete={(id) => remove("groups", id)} deleteLabel={t("deleteBtn")} />
      </section>

      {/* Segments */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("segmentsTitle")}</h2>
        <div className="space-y-2">
          <Input value={segName} onChange={(e) => setSegName(e.target.value)} placeholder={t("newName")} />
          <Select value={segTag} onValueChange={setSegTag}>
            <SelectTrigger><SelectValue placeholder={t("segmentAnyTag")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("segmentAnyTag")}</SelectItem>
              {tags.map((tg) => <SelectItem key={tg.id} value={tg.id}>{tg.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={segHasEmail} onChange={(e) => setSegHasEmail(e.target.checked)} className="h-4 w-4 accent-primary" />
            {t("segmentHasEmail")}
          </label>
          <Button onClick={createSegment} disabled={busy} className="w-full gap-2">
            <Plus className="h-4 w-4" />
            {t("createSegment")}
          </Button>
        </div>
        <ManagedList items={segments} empty={t("noSegments")} onDelete={(id) => remove("segments", id)} deleteLabel={t("deleteBtn")} />
      </section>
    </div>
  );
}

function ManagedList({
  items, empty, onDelete, deleteLabel,
}: {
  items: Named[];
  empty: string;
  onDelete: (id: string) => void;
  deleteLabel: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 truncate text-sm">{item.name}</span>
          <Button variant="ghost" size="icon" onClick={() => onDelete(item.id)} aria-label={deleteLabel}>
            <Trash2 className="h-4 w-4 text-status-late" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
