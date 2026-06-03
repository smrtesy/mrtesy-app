"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Check, X, Pencil, Trash2, Loader2, BookOpen,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

type Status = "approved" | "pending" | "rejected";

interface Entry {
  id: string;
  question: string;
  answer: string;
  status: Status;
  source_type: string | null;
  language: string | null;
  created_by: string | null;
  created_at: string;
}

type SheetState =
  | null
  | { mode: "add" }
  | { mode: "edit"; id: string };

export function KnowledgeCenter() {
  const t = useTranslations("knowledge");
  const locale = useLocale();

  const [tab, setTab] = useState<Status>("approved");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [role, setRole] = useState<"owner" | "admin" | "member">("member");
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [sheet, setSheet] = useState<SheetState>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);

  const isManager = role === "owner" || role === "admin";

  const load = useCallback(async (status: Status) => {
    setLoading(true);
    try {
      const data = await api<{ entries: Entry[]; role: typeof role; user_id: string }>(
        `/api/knowledge?status=${status}`,
      );
      setEntries(data.entries);
      setRole(data.role);
      setMyUserId(data.user_id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  function openAdd() {
    setQuestion(""); setAnswer(""); setSheet({ mode: "add" });
  }
  function openEdit(entry: Entry) {
    setQuestion(entry.question); setAnswer(entry.answer);
    setSheet({ mode: "edit", id: entry.id });
  }

  async function handleSubmit() {
    if (!question.trim() || !answer.trim() || !sheet) return;
    setSaving(true);
    try {
      if (sheet.mode === "edit") {
        await api(`/api/knowledge/${sheet.id}`, {
          method: "PATCH",
          body: { question: question.trim(), answer: answer.trim() },
        });
        toast.success(t("saved"));
      } else {
        const res = await api<{ status: Status }>("/api/knowledge", {
          method: "POST",
          body: { question: question.trim(), answer: answer.trim(), language: locale },
        });
        toast.success(res.status === "pending" ? t("submittedForApproval") : t("saved"));
      }
      setSheet(null);
      load(tab);
    } catch (e) {
      const msg = (e as Error).message;
      toast.error(msg.includes("embedding_unavailable") ? t("embeddingUnavailable") : msg);
    } finally {
      setSaving(false);
    }
  }

  async function act(id: string, path: string, method: "POST" | "DELETE", okMsg: string) {
    try {
      await api(`/api/knowledge/${id}${path}`, { method });
      toast.success(okMsg);
      load(tab);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function handleDelete(id: string) {
    if (!confirm(t("deleteConfirm"))) return;
    act(id, "", "DELETE", t("deleted"));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-start flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-status-ok" />
          {t("title")}
        </h1>
        <Button size="sm" className="gap-1" onClick={openAdd}>
          <Plus className="h-4 w-4" />
          {t("add")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {isManager ? t("introManager") : t("introMember")}
      </p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Status)}>
        <TabsList>
          <TabsTrigger value="approved">{t("tabApproved")}</TabsTrigger>
          <TabsTrigger value="pending">{t("tabPending")}</TabsTrigger>
          <TabsTrigger value="rejected">{t("tabRejected")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <BookOpen className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const canDelete = isManager || entry.created_by === myUserId;
            return (
              <article key={entry.id} className="rounded-lg border bg-card px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium leading-snug flex-1 min-w-0" dir="auto">
                    {entry.question}
                  </p>
                  {entry.source_type && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {entry.source_type}
                    </Badge>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap" dir="auto">
                  {entry.answer}
                </p>
                <div className="mt-2 flex items-center gap-1 justify-end flex-wrap">
                  {isManager && entry.status !== "approved" && (
                    <Button size="sm" variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-status-ok"
                      onClick={() => act(entry.id, "/approve", "POST", t("approved"))}>
                      <Check className="h-3.5 w-3.5" />{t("approve")}
                    </Button>
                  )}
                  {isManager && entry.status !== "rejected" && (
                    <Button size="sm" variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-status-warn"
                      onClick={() => act(entry.id, "/reject", "POST", t("rejected"))}>
                      <X className="h-3.5 w-3.5" />{t("reject")}
                    </Button>
                  )}
                  {isManager && (
                    <Button size="sm" variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                      onClick={() => openEdit(entry)}>
                      <Pencil className="h-3.5 w-3.5" />{t("edit")}
                    </Button>
                  )}
                  {canDelete && (
                    <Button size="sm" variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(entry.id)}>
                      <Trash2 className="h-3.5 w-3.5" />{t("delete")}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent side="bottom" dir={locale === "he" ? "rtl" : "ltr"} className="h-auto max-h-[80vh]">
          <SheetHeader>
            <SheetTitle className="text-start">
              {sheet?.mode === "edit" ? t("editTitle") : t("addTitle")}
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">{t("questionLabel")}</p>
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={t("questionPlaceholder")}
                className="min-h-[48px]" dir="auto" autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">{t("answerLabel")}</p>
              <Textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t("answerPlaceholder")}
                className="min-h-[140px]" dir="auto"
              />
            </div>
            {!isManager && sheet?.mode === "add" && (
              <p className="text-xs text-muted-foreground">{t("memberAddHint")}</p>
            )}
            <Button onClick={handleSubmit} disabled={saving || !question.trim() || !answer.trim()}
              className="w-full min-h-[48px]">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("save")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
