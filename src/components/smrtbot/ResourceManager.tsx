"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api/client";
import type { FieldDef, ResourceConfig } from "./resourceConfigs";

type Row = Record<string, unknown> & { id: string };

function coerce(field: FieldDef, raw: string | boolean): unknown {
  if (field.type === "number") return raw === "" ? null : Number(raw);
  if (field.type === "bool") return Boolean(raw);
  return raw === "" ? null : raw;
}

export function ResourceManager({ botId, config }: { botId: string; config: ResourceConfig }) {
  const t = useTranslations("smrtBot");
  const label = (k: string) => (t.has(`f_${k}`) ? t(`f_${k}`) : k);

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [env, setEnv] = useState<"test" | "live">("live");

  const base = `/api/bot/${botId}/${config.resource}`;

  const load = useCallback(async () => {
    setRows(null);
    try {
      const url = config.hasEnv ? `${base}?env=${env}` : base;
      const res = await api<Record<string, Row[]>>(url);
      setRows(res[config.resource] ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [base, config.resource, config.hasEnv, env]);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    const init: Record<string, string | boolean> = {};
    for (const f of config.fields) init[f.key] = f.type === "bool" ? true : "";
    if (config.hasEnv) init.env = env; // default new items to the active env tab
    setForm(init);
    setEditing(null);
    setOpen(true);
  }

  function openEdit(row: Row) {
    const init: Record<string, string | boolean> = {};
    for (const f of config.fields) {
      const v = row[f.key];
      init[f.key] = f.type === "bool" ? Boolean(v) : v == null ? "" : String(v);
    }
    setForm(init);
    setEditing(row);
    setOpen(true);
  }

  async function save() {
    for (const f of config.fields) {
      if (f.required && (form[f.key] === "" || form[f.key] == null)) {
        toast.error(`${label(f.key)} —`);
        return;
      }
    }
    const body: Record<string, unknown> = {};
    for (const f of config.fields) body[f.key] = coerce(f, form[f.key] ?? "");
    setSaving(true);
    try {
      if (editing) await api(`${base}/${editing.id}`, { method: "PATCH", body });
      else await api(base, { method: "POST", body });
      toast.success(t("updated"));
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: Row) {
    if (!confirm(t("confirmDelete"))) return;
    try {
      await api(`${base}/${row.id}`, { method: "DELETE" });
      setRows((prev) => (prev ? prev.filter((r) => r.id !== row.id) : prev));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }

  async function runAction(row: Row, key: string) {
    try {
      await api(`${base}/${row.id}/${key}`, { method: "POST" });
      toast.success(t("updated"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown error");
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        {config.hasEnv ? (
          <div className="inline-flex rounded-md border border-border p-0.5">
            {(["test", "live"] as const).map((e) => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                className={
                  "rounded px-3 py-1 text-sm " +
                  (env === e ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")
                }
              >
                {t(e === "live" ? "envLive" : "envTest")}
              </button>
            ))}
          </div>
        ) : <span />}
        {!config.readOnlyCreate && (
          <Button onClick={openNew}>
            <Plus className="me-2 h-4 w-4" />
            {t("addItem")}
          </Button>
        )}
      </div>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
          {t("noItems")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {config.columns.map((c) => (
                  <th key={c} className="px-3 py-2 text-start font-medium">{label(c)}</th>
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  {config.columns.map((c) => (
                    <td key={c} className="max-w-[18rem] truncate px-3 py-2" dir="auto">
                      {String(row[c] ?? "")}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-end">
                    {config.rowActions?.map((a) => (
                      <Button key={a.key} variant="outline" size="sm" className="me-1" onClick={() => runAction(row, a.key)}>
                        {t(`act_${a.key}`)}
                      </Button>
                    ))}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(row)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(row)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("editItem") : t("addItem")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {config.fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-sm font-medium">{label(f.key)}{f.required ? " *" : ""}</label>
                {f.type === "textarea" ? (
                  <Textarea
                    dir="auto"
                    value={String(form[f.key] ?? "")}
                    onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                ) : f.type === "bool" ? (
                  <input
                    type="checkbox"
                    className="block h-4 w-4"
                    checked={Boolean(form[f.key])}
                    onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.checked }))}
                  />
                ) : f.type === "select" ? (
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={String(form[f.key] ?? "")}
                    onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  >
                    <option value="" />
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <Input
                    type={f.type === "number" ? "number" : "text"}
                    dir={f.type === "number" ? "ltr" : "auto"}
                    value={String(form[f.key] ?? "")}
                    onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={save} disabled={saving}>{saving ? "…" : t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
