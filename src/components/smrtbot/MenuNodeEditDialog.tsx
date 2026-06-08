"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import type { MenuNode } from "./MenuDiagram";

// Scalar fields editable from the diagram. Buttons live in the table editor.
const TEXT_FIELDS = ["label", "title_he", "action", "image_url", "parent_key"] as const;

/** Edit a single menu node's content, opened by clicking a node title in the
 *  diagram. Saves via PATCH /api/bot/:botId/menu/:id. */
export function MenuNodeEditDialog({
  botId,
  node,
  onClose,
  onSaved,
}: {
  botId: string;
  node: MenuNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("smrtBot");
  const [form, setForm] = useState<Record<string, string>>(() => ({
    label: node.label ?? "",
    title_he: node.title_he ?? "",
    body_text: node.body_text ?? "",
    type: node.type ?? "menu",
    action: node.action ?? "",
    image_url: node.image_url ?? "",
    parent_key: node.parent_key ?? "",
  }));
  const [active, setActive] = useState<boolean>(node.active);
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      await api(`/api/bot/${botId}/menu/${node.id}`, {
        method: "PATCH",
        body: {
          label: form.label,
          title_he: form.title_he || null,
          body_text: form.body_text || null,
          type: form.type,
          action: form.action || null,
          image_url: form.image_url || null,
          parent_key: form.parent_key || null,
          active,
        },
      });
      toast.success(t("updated"));
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle dir="ltr" className="font-mono text-sm">{node.node_key}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_title_he")}</label>
            <Input dir="auto" value={form.title_he} onChange={(e) => set("title_he", e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_body_text")}</label>
            <Textarea dir="auto" rows={3} value={form.body_text} onChange={(e) => set("body_text", e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_type")}</label>
            <select
              value={form.type}
              onChange={(e) => set("type", e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {["menu", "text", "action", "video_list"].map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>
          {TEXT_FIELDS.filter((f) => f !== "title_he").map((f) => (
            <div key={f} className="space-y-1">
              <label className="text-sm font-medium">{t(`f_${f}`)}</label>
              <Input dir={f === "label" ? "auto" : "ltr"} value={form[f]} onChange={(e) => set(f, e.target.value)} />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4" />
            {t("f_active")}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>{saving ? "…" : t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
