"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, X, BookOpen, User, Tag, Clock, Link2, FileText } from "lucide-react";
import { toast } from "sonner";

interface Fact {
  id: string;
  type: "contact" | "keyword" | "timeline" | "link" | "topic" | "note";
  value: string;
  extracted_at: string;
}

interface BriefFactVerifierProps {
  projectId: string;
  briefId: string;
  pendingFacts: Fact[];
  locale: string;
}

const typeIcons: Record<Fact["type"], typeof User> = {
  contact: User,
  keyword: Tag,
  timeline: Clock,
  link: Link2,
  topic: BookOpen,
  note: FileText,
};

const typeColors: Record<Fact["type"], string> = {
  contact: "bg-blue-50 text-blue-700",
  keyword: "bg-purple-50 text-purple-700",
  timeline: "bg-orange-50 text-orange-700",
  link: "bg-green-50 text-green-700",
  topic: "bg-yellow-50 text-yellow-700",
  note: "bg-gray-50 text-gray-700",
};

export function BriefFactVerifier({ projectId, pendingFacts: initialFacts, locale }: BriefFactVerifierProps) {
  const [facts, setFacts] = useState<Fact[]>(initialFacts);
  const [saving, setSaving] = useState<string | null>(null);

  const isHe = locale === "he";

  const handleVerify = useCallback(async (fact: Fact, approve: boolean) => {
    setSaving(fact.id);
    try {
      // Server handles: moves fact between pending/verified/rejected arrays
      // AND appends approved keyword/contact facts to projects.keywords/key_contacts.
      await api(`/api/projects/${projectId}/brief/verify-fact`, {
        method: "PATCH",
        body: { fact_id: fact.id, approve },
      });

      setFacts((prev) => prev.filter((f) => f.id !== fact.id));
      toast.success(approve
        ? (isHe ? "עובדה אושרה" : "Fact approved")
        : (isHe ? "עובדה נדחתה" : "Fact rejected"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(null);
    }
  }, [projectId, isHe]);

  if (facts.length === 0) return null;

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-blue-600" />
          {isHe ? `AI למד ${facts.length} עובדות — אשר כל אחת` : `AI learned ${facts.length} facts — verify each`}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {isHe
            ? "אשר עובדות נכונות כדי לשפר את ההתאמה לפרויקט זה בעתיד"
            : "Approve correct facts to improve future project matching"}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {facts.map((fact) => {
          const Icon = typeIcons[fact.type] ?? FileText;
          const colorClass = typeColors[fact.type] ?? typeColors.note;
          const isSaving = saving === fact.id;
          return (
            <div key={fact.id} className="flex items-center gap-2 rounded-lg border bg-background p-2.5">
              <div className={`rounded-full p-1.5 ${colorClass}`}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <Badge variant="outline" className={`text-[10px] mb-0.5 ${colorClass} border-0`}>
                  {fact.type}
                </Badge>
                <p className="text-sm leading-snug" dir="auto">{fact.value}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                  disabled={isSaving}
                  onClick={() => handleVerify(fact, false)}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                  disabled={isSaving}
                  onClick={() => handleVerify(fact, true)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
