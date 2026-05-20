"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Pencil } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface SmartTaskInputProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface ParsedTask {
  title_he: string;
  description: string;
  due_date: string | null;
  priority: string;
  recurrence_rule: string | null;
  reminders: Array<{ days_before: number; message: string }>;
  checklist: string[];
}

export function SmartTaskInput({ open, onClose, onCreated }: SmartTaskInputProps) {
  const t = useTranslations("tasks.smartInput");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [editingDates, setEditingDates] = useState(false);
  const [editDueDate, setEditDueDate] = useState("");

  async function handleParse() {
    if (!input.trim()) return;
    setLoading(true);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const { result } = await api<{ result: string }>("/api/quick-action", {
        method: "POST",
        body: {
          prompt: `Parse this natural language input into a task. Today is ${today}. Return ONLY valid JSON, no markdown fences:
{"title_he":"Hebrew title","description":"details","due_date":"YYYY-MM-DD or null","priority":"urgent|high|medium|low","recurrence_rule":"RRULE string or null","reminders":[{"days_before":1,"message":"reminder text"}],"checklist":["item 1","item 2"]}

For "checklist": only populate when the input clearly describes multiple discrete sub-items (e.g. a shopping list, a meeting-prep list, a packing list, "do A, then B, then C"). Each item should be a short imperative phrase in the same language as the input. If the input describes a single action with no sub-items, return an empty array.

User input: "${input}"`,
          max_tokens: 700,
        },
      });

      const jsonMatch = (result || "").match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const taskData = JSON.parse(jsonMatch[0]) as Partial<ParsedTask>;
        const checklist = Array.isArray(taskData.checklist)
          ? taskData.checklist.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          : [];
        setParsed({
          title_he: taskData.title_he ?? input,
          description: taskData.description ?? "",
          due_date: taskData.due_date ?? null,
          priority: taskData.priority ?? "medium",
          recurrence_rule: taskData.recurrence_rule ?? null,
          reminders: Array.isArray(taskData.reminders) ? taskData.reminders : [],
          checklist,
        });
        setEditDueDate(taskData.due_date || "");
      } else {
        throw new Error("could not parse model output");
      }
    } catch {
      // Fallback: AI call or JSON parse failed — create a basic task from
      // raw input and let the user fix it manually.
      toast.error("AI parsing failed — using raw input");
      setParsed({
        title_he: input,
        description: "",
        due_date: null,
        priority: "medium",
        recurrence_rule: null,
        reminders: [],
        checklist: [],
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!parsed) return;
    setLoading(true);

    try {
      // 1. Create the task via Express
      const now = new Date().toISOString();
      const checklist = (parsed.checklist ?? []).map((title) => ({
        id: crypto.randomUUID(),
        title,
        done: false,
        created_at: now,
        completed_at: null,
        created_by: "ai" as const,
      }));

      const { task } = await api<{ task: { id: string } }>("/api/tasks", {
        method: "POST",
        body: {
          title: parsed.title_he,
          title_he: parsed.title_he,
          description: parsed.description,
          priority: parsed.priority,
          status: "inbox",
          due_date: editDueDate || parsed.due_date || null,
          recurrence_rule: parsed.recurrence_rule,
          ...(checklist.length > 0 ? { checklist } : {}),
        },
      });

      // 2. Append the initial update entry (server seeds task.updates = [])
      if (parsed.description || parsed.title_he) {
        await api(`/api/tasks/${task.id}/updates`, {
          method: "POST",
          body: { content: parsed.description || parsed.title_he, type: "initial" },
        });
      }

      // 3. Create reminders if any
      if (parsed.reminders?.length && parsed.due_date) {
        for (const reminder of parsed.reminders) {
          const remindAt = new Date(parsed.due_date);
          remindAt.setDate(remindAt.getDate() - reminder.days_before);
          remindAt.setHours(9, 0, 0, 0);

          await api("/api/reminders", {
            method: "POST",
            body: {
              task_id: task.id,
              remind_at: remindAt.toISOString(),
              message: reminder.message,
              message_he: reminder.message,
              source: "manual",
            },
          });
        }
      }

      toast.success(t("confirmDates"));
      setInput("");
      setParsed(null);
      onCreated();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setInput("");
    setParsed(null);
    setEditingDates(false);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent side="bottom" className="h-auto max-h-[80vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start">{t("placeholder")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 py-4">
          {!parsed ? (
            <>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleParse()}
                placeholder={t("placeholder")}
                className="min-h-[48px]"
                dir="auto"
                autoFocus
              />
              <Button
                onClick={handleParse}
                disabled={loading || !input.trim()}
                className="w-full min-h-[48px]"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("confirmDates")}
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              {/* Parsed result preview */}
              <div className="rounded-lg border p-3 space-y-2">
                <h4 className="font-medium" dir="auto">{parsed.title_he}</h4>
                {parsed.description && (
                  <p className="text-sm text-muted-foreground" dir="auto">{parsed.description}</p>
                )}
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="outline">{parsed.priority}</Badge>
                  {(editingDates ? editDueDate : parsed.due_date) && (
                    <Badge variant="secondary">
                      {new Date(editingDates ? editDueDate : parsed.due_date!).toLocaleDateString("he-IL")}
                    </Badge>
                  )}
                  {parsed.recurrence_rule && (
                    <Badge variant="secondary">Recurring</Badge>
                  )}
                </div>
                {parsed.checklist?.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {parsed.checklist.map((item, i) => (
                      <li key={i} className="flex items-start gap-2" dir="auto">
                        <span className="text-muted-foreground">☐</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Date editing */}
              {editingDates && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Due Date</label>
                  <Input
                    type="date"
                    value={editDueDate}
                    onChange={(e) => setEditDueDate(e.target.value)}
                  />
                </div>
              )}

              {/* Confirm / Edit buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={handleConfirm}
                  disabled={loading}
                  className="flex-1 min-h-[48px] gap-1"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {t("confirmDates")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEditingDates(!editingDates)}
                  className="min-h-[48px] gap-1"
                >
                  <Pencil className="h-4 w-4" />
                  {t("editDates")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
