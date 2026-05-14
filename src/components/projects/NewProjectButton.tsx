"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Plus, Loader2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

const COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
  "#8B5CF6", "#EC4899", "#06B6D4", "#6366F1",
];

export function NewProjectButton({ locale, label }: { locale: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setLoading(true);

    try {
      const { project } = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: { name: name.trim(), name_he: name.trim(), color },
      });

      toast.success(locale === "he" ? "פרויקט נוצר" : "Project created");
      setName("");
      setOpen(false);
      router.push(`/${locale}/projects/${project.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button size="sm" className="gap-1" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {label}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-auto max-h-[60vh]">
          <SheetHeader>
            <SheetTitle className="text-start">
              {locale === "he" ? "פרויקט חדש" : "New Project"}
            </SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder={locale === "he" ? "שם הפרויקט" : "Project name"}
              className="min-h-[48px]"
              dir="auto"
              autoFocus
            />
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                {locale === "he" ? "צבע" : "Color"}
              </p>
              <div className="flex gap-2 flex-wrap">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`h-8 w-8 rounded-full border-2 transition-all ${
                      color === c ? "border-foreground scale-110" : "border-transparent"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <Button
              onClick={handleCreate}
              disabled={loading || !name.trim()}
              className="w-full min-h-[48px]"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === "he" ? "צור פרויקט" : "Create Project")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
