"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Pencil, X, Plus, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

const COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
  "#8B5CF6", "#EC4899", "#06B6D4", "#6366F1",
];

interface Brief {
  id: string;
  purpose?: string | null;
  target_audience?: string | null;
  current_status?: string | null;
  ai_context?: string | null;
}

interface Project {
  id: string;
  name: string;
  name_he?: string | null;
  color?: string | null;
  keywords?: string[] | null;
  key_contacts?: string[] | null;
}

interface EditProjectSheetProps {
  project: Project;
  brief?: Brief | null;
  locale: string;
}

export function EditProjectSheet({ project, brief, locale }: EditProjectSheetProps) {
  const tEdit = useTranslations("projectsEdit");
  const router = useRouter();
  const isHe = locale === "he";

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Project fields
  const [name, setName] = useState(project.name);
  const [nameHe, setNameHe] = useState(project.name_he ?? "");
  const [color, setColor] = useState(project.color ?? COLORS[0]);
  const [keywords, setKeywords] = useState<string[]>(project.keywords ?? []);
  const [contacts, setContacts] = useState<string[]>(project.key_contacts ?? []);
  const [kwInput, setKwInput] = useState("");
  const [ctInput, setCtInput] = useState("");

  // Brief fields
  const [purpose, setPurpose] = useState(brief?.purpose ?? "");
  const [targetAudience, setTargetAudience] = useState(brief?.target_audience ?? "");
  const [currentStatus, setCurrentStatus] = useState(brief?.current_status ?? "");
  const [aiContext, setAiContext] = useState(brief?.ai_context ?? "");

  function addKeyword() {
    const v = kwInput.trim();
    if (v && !keywords.includes(v)) setKeywords((k) => [...k, v]);
    setKwInput("");
  }

  function addContact() {
    const v = ctInput.trim();
    if (v && !contacts.includes(v)) setContacts((c) => [...c, v]);
    setCtInput("");
  }

  async function handleSave() {
    if (!name.trim()) { toast.error(tEdit("nameRequired")); return; }
    setSaving(true);
    try {
      // 1. Update project core fields
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          name_he: nameHe.trim() || name.trim(),
          color,
          keywords,
          key_contacts: contacts,
        },
      });

      // 2. Upsert brief (the PUT endpoint handles create-vs-update on its own)
      const hasBriefContent =
        purpose.trim() || targetAudience.trim() || currentStatus.trim() || aiContext.trim();
      if (hasBriefContent || brief?.id) {
        await api(`/api/projects/${project.id}/brief`, {
          method: "PUT",
          body: {
            purpose: purpose.trim() || null,
            target_audience: targetAudience.trim() || null,
            current_status: currentStatus.trim() || null,
            ai_context: aiContext.trim() || null,
          },
        });
      }

      toast.success(tEdit("projectUpdated"));
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error saving");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5" />
        {tEdit("edit")}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[480px] p-0 flex flex-col max-md:!w-full max-md:!max-w-full max-md:!inset-0 max-md:!top-[5vh]"
        >
          <SheetHeader className="sticky top-0 z-10 bg-background border-b px-4 py-3">
            <SheetTitle className="text-start">
              {tEdit("editProject")}
            </SheetTitle>
          </SheetHeader>

          <ScrollArea className="flex-1 px-4 py-4">
            <div className="space-y-5">

              {/* ── Project Info ── */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tEdit("projectInfo")}
                </h3>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("nameEnglish")}</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("nameHebrew")}</label>
                  <Input
                    value={nameHe}
                    onChange={(e) => setNameHe(e.target.value)}
                    dir="rtl"
                    placeholder={tEdit("optional")}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("color")}</label>
                  <div className="flex gap-2 flex-wrap">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className={`h-8 w-8 rounded-full border-2 transition-all ${
                          color === c ? "border-foreground scale-110" : "border-transparent"
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </section>

              <Separator />

              {/* ── Keywords ── */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tEdit("keywords")}
                </h3>
                <div className="flex gap-2">
                  <Input
                    value={kwInput}
                    onChange={(e) => setKwInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
                    placeholder={tEdit("addKeywordPlaceholder")}
                    dir="auto"
                    className="flex-1"
                  />
                  <Button type="button" size="icon" variant="outline" onClick={addKeyword}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {keywords.map((kw) => (
                      <span
                        key={kw}
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
                        style={{ borderColor: color, color }}
                      >
                        {kw}
                        <button type="button" onClick={() => setKeywords((k) => k.filter((x) => x !== kw))}>
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              {/* ── Key Contacts ── */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tEdit("keyContacts")}
                </h3>
                <div className="flex gap-2">
                  <Input
                    value={ctInput}
                    onChange={(e) => setCtInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addContact(); } }}
                    placeholder={tEdit("addContactPlaceholder")}
                    dir="auto"
                    className="flex-1"
                  />
                  <Button type="button" size="icon" variant="outline" onClick={addContact}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {contacts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {contacts.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs border-muted-foreground/40 text-muted-foreground"
                      >
                        {c}
                        <button type="button" onClick={() => setContacts((cs) => cs.filter((x) => x !== c))}>
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              {/* ── Brief ── */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {tEdit("projectBrief")}
                </h3>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("purpose")}</label>
                  <Textarea
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder={tEdit("purposePlaceholder")}
                    className="min-h-[80px]"
                    dir="auto"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("targetAudience")}</label>
                  <Input
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    placeholder={tEdit("targetAudiencePlaceholder")}
                    dir="auto"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">{tEdit("currentStatus")}</label>
                  <Input
                    value={currentStatus}
                    onChange={(e) => setCurrentStatus(e.target.value)}
                    placeholder={tEdit("currentStatusPlaceholder")}
                    dir="auto"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    {tEdit("aiContext")}
                  </label>
                  <Textarea
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    placeholder={tEdit("aiContextPlaceholder")}
                    className="min-h-[80px]"
                    dir="auto"
                  />
                </div>
              </section>
            </div>
          </ScrollArea>

          {/* Sticky save */}
          <div className="sticky bottom-0 border-t bg-background px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <Button
              className="w-full gap-2"
              onClick={handleSave}
              disabled={saving || !name.trim()}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? tEdit("saving") : tEdit("saveChanges")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
