"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  StickyNote,
  Link as LinkIcon,
  FileText,
  User,
  ExternalLink,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import type { TaskMaterial, TaskMaterialType } from "@/types/task";

interface Props {
  taskId: string;
  items: TaskMaterial[];
  onChange: () => void;
}

interface DraftNote    { type: "note";    title: string; content: string }
interface DraftLink    { type: "link";    title: string; url: string }
interface DraftContact { type: "contact"; title: string; contact_name: string; contact_email: string; contact_phone: string }
type Draft = DraftNote | DraftLink | DraftContact | null;

const TYPE_ICONS: Record<TaskMaterialType, typeof StickyNote> = {
  note:    StickyNote,
  link:    LinkIcon,
  file:    FileText,
  contact: User,
};

export function TaskMaterials({ taskId, items, onChange }: Props) {
  const t = useTranslations("tasks.materials");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function persist(next: TaskMaterial[]) {
    setSaving(true);
    try {
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: { task_materials: next } });
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function addDraft() {
    if (!draft) return;
    const base = { id: crypto.randomUUID(), created_at: new Date().toISOString(), created_by: "user" };
    let entry: TaskMaterial;
    if (draft.type === "note") {
      if (!draft.title.trim() && !draft.content.trim()) return;
      entry = { ...base, type: "note", title: draft.title.trim() || draft.content.slice(0, 40), content: draft.content.trim() };
    } else if (draft.type === "link") {
      if (!draft.url.trim()) return;
      entry = { ...base, type: "link", title: draft.title.trim() || draft.url, url: draft.url.trim() };
    } else {
      if (!draft.contact_name.trim() && !draft.contact_email.trim() && !draft.contact_phone.trim()) return;
      entry = {
        ...base,
        type: "contact",
        title: draft.title.trim() || draft.contact_name.trim() || draft.contact_email.trim() || draft.contact_phone.trim(),
        contact_name:  draft.contact_name.trim()  || undefined,
        contact_email: draft.contact_email.trim() || undefined,
        contact_phone: draft.contact_phone.trim() || undefined,
      };
    }
    setDraft(null);
    await persist([...items, entry]);
  }

  async function handleFileUpload(file: File) {
    setUploading(true);
    try {
      const data = await fileToBase64(file);
      const resp = await api<{
        url: string; file_path: string; file_size: number; file_mime: string; filename: string;
      }>(`/api/tasks/${taskId}/materials/upload`, {
        method: "POST",
        body: { filename: file.name, mime: file.type, data },
      });
      const entry: TaskMaterial = {
        id: crypto.randomUUID(),
        type: "file",
        title: resp.filename,
        url: resp.url,
        file_path: resp.file_path,
        file_size: resp.file_size,
        file_mime: resp.file_mime,
        created_at: new Date().toISOString(),
        created_by: "user",
      };
      await persist([...items, entry]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function remove(id: string) {
    await persist(items.filter((m) => m.id !== id));
  }

  function pickType(type: TaskMaterialType) {
    if (type === "file") {
      fileInputRef.current?.click();
      return;
    }
    if (type === "note")    setDraft({ type: "note",    title: "", content: "" });
    if (type === "link")    setDraft({ type: "link",    title: "", url: "" });
    if (type === "contact") setDraft({ type: "contact", title: "", contact_name: "", contact_email: "", contact_phone: "" });
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between py-2 text-sm font-medium"
      >
        <span>
          {t("title")}{items.length > 0 && ` (${items.length})`}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {open && (
        <div className="space-y-2 mt-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1" disabled={saving || uploading}>
                <Plus className="h-3 w-3" /> {t("addButton")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => pickType("note")}>
                <StickyNote className="h-3.5 w-3.5 me-2" /> {t("addNote")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pickType("link")}>
                <LinkIcon className="h-3.5 w-3.5 me-2" /> {t("addLink")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pickType("file")}>
                <FileText className="h-3.5 w-3.5 me-2" /> {t("addFile")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => pickType("contact")}>
                <User className="h-3.5 w-3.5 me-2" /> {t("addContact")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFileUpload(f);
            }}
          />
          {uploading && <p className="text-xs text-muted-foreground">{t("uploading")}</p>}

          {draft && (
            <div className="space-y-2 rounded border p-2 bg-muted/30">
              {draft.type === "note" && (
                <>
                  <Input
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={t("materialTitle")}
                    dir="auto"
                  />
                  <Textarea
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    placeholder={t("noteContent")}
                    className="min-h-[80px]"
                    dir="auto"
                  />
                </>
              )}
              {draft.type === "link" && (
                <>
                  <Input
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder={t("materialTitle")}
                    dir="auto"
                  />
                  <Input
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder={t("linkUrl")}
                    type="url"
                    dir="ltr"
                  />
                </>
              )}
              {draft.type === "contact" && (
                <>
                  <Input
                    value={draft.contact_name}
                    onChange={(e) => setDraft({ ...draft, contact_name: e.target.value })}
                    placeholder={t("contactName")}
                    dir="auto"
                  />
                  <Input
                    value={draft.contact_email}
                    onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })}
                    placeholder={t("contactEmail")}
                    type="email"
                    dir="ltr"
                  />
                  <Input
                    value={draft.contact_phone}
                    onChange={(e) => setDraft({ ...draft, contact_phone: e.target.value })}
                    placeholder={t("contactPhone")}
                    type="tel"
                    dir="ltr"
                  />
                </>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={addDraft} disabled={saving}>
                  <Plus className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}

          {items.length === 0 && !draft && (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          )}

          {items.map((m) => {
            const Icon = TYPE_ICONS[m.type];
            return (
              <div key={m.id} className="rounded border p-2 text-xs">
                <div className="flex items-start gap-2">
                  <Icon className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium break-words" dir="auto">{m.title}</div>

                    {m.type === "note" && m.content && (
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground" dir="auto">
                        {m.content}
                      </p>
                    )}

                    {m.type === "link" && m.url && isSafeUrl(m.url) && (
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline break-all"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {m.url}
                      </a>
                    )}

                    {m.type === "file" && m.url && (
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {m.file_size ? `${Math.round(m.file_size / 1024)} KB` : "open"}
                      </a>
                    )}

                    {m.type === "contact" && (
                      <div className="mt-1 space-y-0.5 text-muted-foreground">
                        {m.contact_name  && <div dir="auto">{m.contact_name}</div>}
                        {m.contact_email && <a href={`mailto:${m.contact_email}`} className="block text-blue-600 hover:underline" dir="ltr">{m.contact_email}</a>}
                        {m.contact_phone && <a href={`tel:${m.contact_phone}`}   className="block text-blue-600 hover:underline" dir="ltr">{m.contact_phone}</a>}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(m.id)}
                    disabled={saving}
                    className="h-6 w-6 p-0 shrink-0"
                    title={t("removeItem")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Block javascript:/data:/vbscript: schemes — only allow http(s), mailto, tel.
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return /^(https?:|mailto:|tel:|\/)/i.test(trimmed);
}
