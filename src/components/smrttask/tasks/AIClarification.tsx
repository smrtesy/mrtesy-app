"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, MessageSquareWarning, Send } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface AIClarificationProps {
  taskId: string;
  questions: Array<{ id: string; question: string; field: string }>;
  onAnswered: () => void;
}

export function AIClarification({ taskId, questions, onAnswered }: AIClarificationProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  if (!questions || questions.length === 0) return null;

  const visibleQuestions = questions.filter((q) => !dismissed.has(q.id));
  if (visibleQuestions.length === 0) return null;

  async function handleAnswer(questionId: string, field: string) {
    const answer = answers[questionId];
    if (!answer?.trim()) return;

    try {
      if (field === "email" || field === "phone" || field === "name") {
        const update: Record<string, string> = {};
        if (field === "email") update.related_contact_email = answer;
        if (field === "phone") update.related_contact_phone = answer;
        if (field === "name")  update.related_contact = answer;
        await api(`/api/tasks/${taskId}`, { method: "PATCH", body: update });
      }

      setDismissed((prev) => new Set(Array.from(prev).concat(questionId)));
      onAnswered();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDismiss(questionId: string) {
    setDismissed((prev) => new Set(Array.from(prev).concat(questionId)));

    // Save to ai_clarification_prefs so this question isn't asked again
    try {
      const { settings } = await api<{ settings: { ai_clarification_prefs: Record<string, boolean> | null } | null }>(
        "/api/me/settings",
      );
      const prefs = (settings?.ai_clarification_prefs ?? {}) as Record<string, boolean>;
      prefs[questionId] = false;
      await api("/api/me/settings", {
        method: "PATCH",
        body: { ai_clarification_prefs: prefs },
      });
    } catch {
      // Non-critical; user already dismissed locally
    }
  }

  return (
    <div className="space-y-2 mt-2">
      {visibleQuestions.slice(0, 2).map((q) => (
        <div key={q.id} className="rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs">
          <div className="flex items-start gap-2">
            <MessageSquareWarning className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-blue-700" dir="auto">{q.question}</p>
              <div className="flex gap-1.5 mt-1.5">
                <Input
                  value={answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && handleAnswer(q.id, q.field)}
                  className="h-7 text-xs"
                  dir="auto"
                  placeholder="..."
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  onClick={() => handleAnswer(q.id, q.field)}
                >
                  <Send className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  onClick={() => handleDismiss(q.id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
