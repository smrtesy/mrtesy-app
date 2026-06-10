"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Lightbulb, CheckSquare, BookmarkPlus, Loader2,
} from "lucide-react";
import { formatDateOnly } from "@/lib/date";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

type ItemType = "suggestion" | "task";

export interface InfoCenterItem {
  id: string;
  type: ItemType;
  title: string;
  body?: string | null;
  priority?: string | null;
  status?: string | null;
  due_date?: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  suggestions: InfoCenterItem[];
  tasks: InfoCenterItem[];
  projectId: string;
  projectName: string;
  subProjects: ProjectOption[];
}

const TYPE_ICON = {
  suggestion: Lightbulb,
  task: CheckSquare,
} as const;

const TYPE_COLOR = {
  suggestion: "text-status-warn",
  task: "text-primary",
} as const;

// The save sheet copies a suggestion/task into the project's Info Center
// (the info items themselves are rendered by InfoBoard, not here).
type SheetState = null | { mode: "saveAs"; title: string; body: string };

export function ProjectInfoCenter({
  suggestions, tasks, projectId, projectName, subProjects,
}: Props) {
  const t = useTranslations("projectDetail");
  const locale = useLocale();
  const router = useRouter();

  const [sheet, setSheet] = useState<SheetState>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [targetId, setTargetId] = useState(projectId);
  const [saving, setSaving] = useState(false);

  function openSaveAs(item: InfoCenterItem) {
    setTitle(item.title); setBody(item.body && item.body !== item.title ? item.body : "");
    setTargetId(projectId);
    setSheet({ mode: "saveAs", title: item.title, body: item.body ?? "" });
  }

  async function handleSubmit() {
    if (!title.trim() || !sheet) return;
    setSaving(true);
    try {
      await api(`/api/projects/${targetId}/info-items`, {
        method: "POST",
        body: { title: title.trim(), body: body.trim() },
      });
      toast.success(targetId === projectId ? t("infoSaved") : t("infoSavedToOther"));
      setSheet(null);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const sections = [
    { type: "suggestion" as ItemType, labelKey: "sectionSuggestions", items: suggestions },
    { type: "task" as ItemType,       labelKey: "sectionTasks",        items: tasks       },
  ].filter((s) => s.items.length > 0);

  if (sections.length === 0) return null;

  return (
    <div className="flex gap-4">
      {/* Sticky left TOC — desktop only */}
      <aside className="hidden md:block w-44 shrink-0 self-start sticky top-4">
        <nav className="space-y-4 text-sm" aria-label={t("infoCenter")}>
          {sections.map(({ type, labelKey, items }) => {
            const Icon = TYPE_ICON[type];
            const colorClass = TYPE_COLOR[type];
            return (
              <div key={type}>
                <a
                  href={`#section-${type}`}
                  className={`flex items-center gap-1.5 font-semibold hover:opacity-75 transition-opacity ${colorClass}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t(labelKey as Parameters<typeof t>[0])}</span>
                  <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
                </a>
                <ul className="mt-1 space-y-0.5 ps-5">
                  {items.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`#item-${item.id}`}
                        className="block text-xs text-muted-foreground hover:text-foreground truncate"
                        title={item.title}
                        dir="auto"
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Content document */}
      <div className="flex-1 min-w-0 space-y-8">
        {/* Mobile TOC chips — horizontal scroll row */}
        <div className="md:hidden flex gap-2 overflow-x-auto pb-1">
          {sections.map(({ type, labelKey, items }) => {
            const Icon = TYPE_ICON[type];
            return (
              <a
                key={type}
                href={`#section-${type}`}
                className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs whitespace-nowrap hover:bg-muted transition-colors"
              >
                <Icon className="h-3 w-3 shrink-0" />
                {t(labelKey as Parameters<typeof t>[0])} ({items.length})
              </a>
            );
          })}
        </div>

        {sections.map(({ type, labelKey, items }) => {
          const Icon = TYPE_ICON[type];
          const colorClass = TYPE_COLOR[type];
          return (
            <section
              key={type}
              id={`section-${type}`}
              className="scroll-mt-16"
              aria-label={t(labelKey as Parameters<typeof t>[0])}
            >
              <h3 className={`flex items-center gap-2 text-sm font-semibold mb-3 ${colorClass}`}>
                <Icon className="h-4 w-4 shrink-0" />
                {t(labelKey as Parameters<typeof t>[0])}
                <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
              </h3>

              <div className="space-y-2">
                {items.map((item) => (
                  <article
                    key={item.id}
                    id={`item-${item.id}`}
                    className="rounded-lg border bg-card px-3 py-2.5 scroll-mt-16"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug flex-1 min-w-0" dir="auto">
                        {item.title}
                      </p>
                      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                        {item.priority && (
                          <Badge variant="outline" className="text-[10px]">
                            {item.priority}
                          </Badge>
                        )}
                        {item.status && (
                          <Badge variant="secondary" className="text-[10px]">
                            {item.status}
                          </Badge>
                        )}
                        {item.due_date && (
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {formatDateOnly(item.due_date, locale)}
                          </span>
                        )}
                      </div>
                    </div>
                    {item.body && item.body !== item.title && (
                      <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed" dir="auto">
                        {item.body}
                      </p>
                    )}

                    {/* Per-card actions */}
                    <div className="mt-2 flex items-center gap-1 justify-end">
                      <Button
                        size="sm" variant="ghost"
                        className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                        onClick={() => openSaveAs(item)}
                      >
                        <BookmarkPlus className="h-3.5 w-3.5" />
                        {t("saveAsInfo")}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Save-as-info sheet */}
      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent side="bottom" dir={locale === "he" ? "rtl" : "ltr"} className="h-auto max-h-[75vh]">
          <SheetHeader>
            <SheetTitle className="text-start">{t("addInfoTitle")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("infoTitlePlaceholder")}
              className="min-h-[48px]"
              dir="auto"
              autoFocus
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("infoBodyPlaceholder")}
              className="min-h-[120px]"
              dir="auto"
            />
            {subProjects.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm text-muted-foreground">{t("infoTarget")}</p>
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={projectId}>{projectName}</SelectItem>
                    {subProjects.map((sp) => (
                      <SelectItem key={sp.id} value={sp.id}>{sp.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button
              onClick={handleSubmit}
              disabled={saving || !title.trim()}
              className="w-full min-h-[48px]"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("infoSave")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
