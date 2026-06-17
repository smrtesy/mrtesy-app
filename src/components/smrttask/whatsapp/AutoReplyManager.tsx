"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api/client";

interface Rule {
  id: string;
  label: string | null;
  match_type: string;
  match_value: string | null;
  response_mode: string;
  reply_text: string | null;
  ai_instructions: string | null;
  priority: number;
  active: boolean;
}
interface Tag {
  id: string;
  phone: string;
  tags: string | null;
}

const MATCH_TYPES = ["phone", "prefix", "tag", "known", "unknown"] as const;
const RESPONSE_MODES = ["reply", "ai"] as const;
const NEEDS_VALUE = new Set(["phone", "prefix", "tag"]);

export function AutoReplyManager() {
  const t = useTranslations("whatsappAutoreply");

  const [connected, setConnected] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, tg] = await Promise.all([
        api<{ connected: boolean; enabled: boolean; phone: string | null }>("/api/me/whatsapp/autoreply-settings"),
        api<{ rules: Rule[] }>("/api/me/whatsapp/autoreply-rules"),
        api<{ tags: Tag[] }>("/api/me/whatsapp/contact-tags"),
      ]);
      setConnected(s.connected);
      setEnabled(s.enabled);
      setPhone(s.phone);
      setRules(r.rules ?? []);
      setTags(tg.tags ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleMaster() {
    const next = !enabled;
    if (next && !confirm(t("enableConfirm"))) return;
    try {
      await api("/api/me/whatsapp/autoreply-settings", { method: "PATCH", body: { enabled: next } });
      setEnabled(next);
      toast.success(t("updated"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  function openNew() {
    setForm({ label: "", match_type: "unknown", match_value: "", response_mode: "reply", reply_text: "", ai_instructions: "", priority: "100", active: true });
    setEditing(null);
    setOpen(true);
  }
  function openEdit(r: Rule) {
    setForm({
      label: r.label ?? "", match_type: r.match_type, match_value: r.match_value ?? "",
      response_mode: r.response_mode, reply_text: r.reply_text ?? "", ai_instructions: r.ai_instructions ?? "",
      priority: String(r.priority), active: r.active,
    });
    setEditing(r);
    setOpen(true);
  }

  async function saveRule() {
    const body = {
      label: (form.label as string) || null,
      match_type: form.match_type,
      match_value: NEEDS_VALUE.has(form.match_type as string) ? (form.match_value as string) || null : null,
      response_mode: form.response_mode,
      reply_text: (form.reply_text as string) || null,
      ai_instructions: (form.ai_instructions as string) || null,
      priority: Number(form.priority) || 100,
      active: Boolean(form.active),
    };
    try {
      if (editing) await api(`/api/me/whatsapp/autoreply-rules/${editing.id}`, { method: "PATCH", body });
      else await api("/api/me/whatsapp/autoreply-rules", { method: "POST", body });
      toast.success(t("updated"));
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function deleteRule(r: Rule) {
    if (!confirm(t("confirmDelete"))) return;
    try {
      await api(`/api/me/whatsapp/autoreply-rules/${r.id}`, { method: "DELETE" });
      setRules((p) => p.filter((x) => x.id !== r.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  async function addTag() {
    const phoneVal = prompt(t("tagPhonePrompt"));
    if (!phoneVal) return;
    const tagsVal = prompt(t("tagTagsPrompt")) ?? "";
    try {
      await api("/api/me/whatsapp/contact-tags", { method: "PUT", body: { phone: phoneVal, tags: tagsVal } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }
  async function deleteTag(tg: Tag) {
    try {
      await api(`/api/me/whatsapp/contact-tags/${tg.id}`, { method: "DELETE" });
      setTags((p) => p.filter((x) => x.id !== tg.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  }

  if (loading) return <p className="p-6 text-sm text-muted-foreground">…</p>;

  const matchType = form.match_type as string;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" dir="auto">
      <div>
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      {!connected ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">{t("notConnected")}</div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{enabled ? t("enabled") : t("disabled")}{phone ? ` · ${phone}` : ""}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("masterWarn")}</div>
            </div>
            <Button variant={enabled ? "destructive" : "default"} onClick={toggleMaster}>
              {enabled ? t("disable") : t("enable")}
            </Button>
          </div>
        </div>
      )}

      {/* Rules */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t("rulesTitle")}</h2>
          <Button size="sm" onClick={openNew}><Plus className="me-1 h-4 w-4" />{t("addRule")}</Button>
        </div>
        {rules.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">{t("noRules")}</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">{t("f_priority")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("f_label")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("f_match_type")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("f_response_mode")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("f_active")}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">{r.priority}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2">{r.label || "—"}</td>
                    <td className="px-3 py-2">{t(`mt_${r.match_type}`)}{r.match_value ? `: ${r.match_value}` : ""}</td>
                    <td className="px-3 py-2">{t(`rm_${r.response_mode}`)}</td>
                    <td className="px-3 py-2">{r.active ? "✓" : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteRule(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Contact tags */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t("tagsTitle")}</h2>
          <Button size="sm" variant="outline" onClick={addTag}><Plus className="me-1 h-4 w-4" />{t("addTag")}</Button>
        </div>
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTags")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tg) => (
              <span key={tg.id} className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm">
                <span dir="ltr">{tg.phone}</span>
                <span className="text-muted-foreground">{tg.tags || "—"}</span>
                <button onClick={() => deleteTag(tg)} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Rule dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? t("editRule") : t("addRule")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label={t("f_label")}>
              <Input dir="auto" value={String(form.label ?? "")} onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))} />
            </Field>
            <Field label={t("f_match_type")}>
              <Select value={matchType} onChange={(v) => setForm((p) => ({ ...p, match_type: v }))} options={MATCH_TYPES.map((m) => ({ v: m, l: t(`mt_${m}`) }))} />
            </Field>
            {NEEDS_VALUE.has(matchType) && (
              <Field label={t("f_match_value")} hint={t("matchValueHint")}>
                <Textarea dir="auto" value={String(form.match_value ?? "")} onChange={(e) => setForm((p) => ({ ...p, match_value: e.target.value }))} />
              </Field>
            )}
            <Field label={t("f_response_mode")}>
              <Select value={String(form.response_mode)} onChange={(v) => setForm((p) => ({ ...p, response_mode: v }))} options={RESPONSE_MODES.map((m) => ({ v: m, l: t(`rm_${m}`) }))} />
            </Field>
            <Field label={t("f_reply_text")}>
              <Textarea dir="auto" value={String(form.reply_text ?? "")} onChange={(e) => setForm((p) => ({ ...p, reply_text: e.target.value }))} />
            </Field>
            {form.response_mode === "ai" && (
              <Field label={t("f_ai_instructions")}>
                <Textarea dir="auto" value={String(form.ai_instructions ?? "")} onChange={(e) => setForm((p) => ({ ...p, ai_instructions: e.target.value }))} />
              </Field>
            )}
            <Field label={t("f_priority")}>
              <Input type="number" dir="ltr" value={String(form.priority ?? "100")} onChange={(e) => setForm((p) => ({ ...p, priority: e.target.value }))} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={Boolean(form.active)} onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))} />
              {t("f_active")}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button onClick={saveRule}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <select
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}
