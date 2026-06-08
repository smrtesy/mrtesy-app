"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Trash2, ArrowUp, ArrowDown, Upload, X } from "lucide-react";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";
import type { MenuNode } from "./MenuDiagram";

// Actions the engine understands (engine.ts / videos.ts / game.ts).
const ACTIONS = [
  "nav_home", "nav_back", "nav_more", "nav_share",
  "holidays_all", "holidays_upcoming", "main_free_search",
  "game_missions", "game_trivia", "game_leaderboard", "game_add_child", "game_settings",
  "game_referral", "game_explain", "game_set_reminders", "game_change_reminder",
  "game_turn_on_reminders", "game_turn_off_reminders", "game_edit_child",
];

const ICON_BUCKET = "smrtbot-web-icons";
const IMG_MAX = 2 * 1024 * 1024;
const IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

interface BtnRow { title: string; target: string }

export function MenuNodeEditDialog({
  botId,
  node,
  allNodes,
  onClose,
  onSaved,
}: {
  botId: string;
  node: MenuNode;
  allNodes: MenuNode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("smrtBot");
  const [titleHe, setTitleHe] = useState(node.title_he ?? "");
  const [bodyText, setBodyText] = useState(node.body_text ?? "");
  const [type, setType] = useState(node.type || "menu");
  const [action, setAction] = useState(node.action ?? "");
  const [parentKey, setParentKey] = useState(node.parent_key ?? "");
  const [imageUrl, setImageUrl] = useState(node.image_url ?? "");
  const [active, setActive] = useState(node.active);
  const [buttons, setButtons] = useState<BtnRow[]>(
    (node.buttons ?? [])
      .map((b) => ({ title: b.title ?? b.label ?? "", target: b.id ?? b.value ?? "" }))
      .filter((b) => b.title || b.target),
  );
  const [split, setSplit] = useState(node.button_layout === "split");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Targets a button (or parent) can point at: existing nodes + engine actions.
  const nodeOptions = allNodes.map((n) => n.node_key).filter((k) => k !== node.node_key);

  function setBtn(i: number, patch: Partial<BtnRow>) {
    setButtons((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function move(i: number, dir: -1 | 1) {
    setButtons((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function uploadImage(file: File | null) {
    if (!file) return;
    if (!IMG_TYPES.includes(file.type)) return toast.error(t("webIconBadType"));
    if (file.size > IMG_MAX) return toast.error(t("webIconTooLarge"));
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${node.org_id}/${botId}/menu/${node.node_key}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from(ICON_BUCKET).upload(path, file, { contentType: file.type });
      if (error) return toast.error(error.message);
      setImageUrl(supabase.storage.from(ICON_BUCKET).getPublicUrl(path).data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api(`/api/bot/${botId}/menu/${node.id}`, {
        method: "PATCH",
        body: {
          title_he: titleHe || null,
          body_text: bodyText || null,
          type,
          action: action || null,
          parent_key: parentKey || null,
          image_url: imageUrl || null,
          active,
          buttons: buttons
            .filter((b) => b.title.trim() && b.target.trim())
            .map((b) => ({ id: b.target.trim(), title: b.title.trim() })),
          button_layout: split ? "split" : "auto",
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

  const selectCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[88vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle dir="ltr" className="font-mono text-sm">{node.node_key}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_title_he")}</label>
            <Input dir="auto" value={titleHe} onChange={(e) => setTitleHe(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_body_text")}</label>
            <Textarea dir="auto" rows={3} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_type")}</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={selectCls}>
              {["menu", "text", "action", "video_list"].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          {type === "action" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("f_action")}</label>
              <select value={action} onChange={(e) => setAction(e.target.value)} className={selectCls} dir="ltr">
                <option value="">{t("menuNone")}</option>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          )}

          {/* Buttons editor */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("menuButtons")}</label>
            {buttons.map((b, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  dir="auto"
                  className="flex-1"
                  placeholder={t("menuBtnTitle")}
                  value={b.title}
                  onChange={(e) => setBtn(i, { title: e.target.value })}
                />
                <select
                  dir="ltr"
                  className={selectCls + " max-w-[40%]"}
                  value={b.target}
                  onChange={(e) => setBtn(i, { target: e.target.value })}
                >
                  <option value="">{t("menuBtnTarget")}</option>
                  <optgroup label="nodes">
                    {nodeOptions.map((k) => <option key={k} value={k}>{k}</option>)}
                  </optgroup>
                  <optgroup label="actions">
                    {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </optgroup>
                </select>
                <button type="button" onClick={() => move(i, -1)} className="p-1 text-muted-foreground hover:text-foreground"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => move(i, 1)} className="p-1 text-muted-foreground hover:text-foreground"><ArrowDown className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setButtons((p) => p.filter((_, idx) => idx !== i))} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setButtons((p) => [...p, { title: "", target: "" }])}>
              <Plus className="me-1 h-3.5 w-3.5" />{t("menuAddButton")}
            </Button>
            {buttons.length > 3 && (
              <label className="flex items-start gap-2 pt-1 text-sm">
                <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span className="text-xs text-muted-foreground">{t("menuSplitLabel")}</span>
              </label>
            )}
          </div>

          {/* Image upload */}
          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_image_url")}</label>
            <div className="flex items-center gap-2">
              {imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="" className="h-12 w-12 rounded border border-border object-cover" />
              )}
              <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                <Upload className="me-1 inline h-3.5 w-3.5" />
                {uploading ? t("webIconUploading") : t("menuUploadImage")}
                <input type="file" accept={IMG_TYPES.join(",")} className="hidden" onChange={(e) => uploadImage(e.target.files?.[0] ?? null)} />
              </label>
              {imageUrl && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setImageUrl("")}>
                  <X className="me-1 h-3.5 w-3.5" />{t("webIconRemove")}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">{t("f_parent_key")}</label>
            <select value={parentKey} onChange={(e) => setParentKey(e.target.value)} className={selectCls} dir="ltr">
              <option value="">{t("menuNone")}</option>
              {nodeOptions.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4" />
            {t("f_active")}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || uploading}>{saving ? "…" : t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
