"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Pencil } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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
}

export function SmartTaskInput({ open, onClose, onCreated }: SmartTaskInputProps) {
  const t = useTranslations("tasks.smartInput");
  const supabase = createClient();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);
  const [editingDates, setEditingDates] = useState(false);
  const [editDueDate, setEditDueDate] = useState("");

  async function handleParse() {
    if (!input.trim()) return;
    setLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Call Sonnet to parse natural language into task JSON
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/quick-action`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            task_id: "new-task",
            action_label: "parse_task",
            prompt: `Parse this natural language into a task. Return ONLY valid JSON:
{"title_he":"Hebrew title","description":"details","due_date":"YYYY-MM-DD or null","priority":"urgent|high|medium|low","recurrence_rule":"RRULE string or null","reminders":[{"days_before":1,"message":"reminder text"}]}

User input: "${input}"`,
          }),
        }
      );

      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      try {
        const jsonMatch = (data.result || "").match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const taskData = JSON.parse(jsonMatch[0]) as ParsedTask;
          setParsed(taskData);
          setEditDueDate(taskData.due_date || "");
        }
      } catch {
        // If JSON parsing fails, create basic task
        setParsed({
          title_he: input,
          description: "",
          due_date: null,
          priority: "medium",
          recurrence_rule: null,
          reminders: [],
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!parsed) return;
    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase.from("tasks").insert({
        user_id: user.id,
        title: parsed.title_he,
        title_he: parsed.title_he,
        description: parsed.description,
        priority: parsed.priority,
        status: "inbox",
        due_date: editDueDate || parsed.due_date || null,
        recurrence_rule: parsed.recurrence_rule,
        task_type: "action",
        updates: [{
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          type: "initial",
          actor: "user",
          content: parsed.description || parsed.title_he,
        }],
      });

      if (error) throw error;

      // Create reminders if any
      if (parsed.reminders?.length && parsed.due_date) {
        for (const reminder of parsed.reminders) {
          const remindAt = new Date(parsed.due_date);
          remindAt.setDate(remindAt.getDate() - reminder.days_before);
          remindAt.setHours(9, 0, 0, 0);

          await supabase.from("reminders").insert({
            user_id: user.id,
            remind_at: remindAt.toISOString(),
            message_he: reminder.message,
            message: reminder.message,
            source: "manual",
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
                <h4 className="font-medium">{parsed.title_he}</h4>
                {parsed.description && (
                  <p className="text-sm text-muted-foreground">{parsed.description}</p>
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
