"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, FolderSearch, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api/client";
import { toast } from "sonner";

interface DriveSearchProps {
  taskId: string;
  taskDescription: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

interface DriveFile {
  id: string;
  name: string;
  webViewLink: string;
  mimeType: string;
}

export function DriveSearch({ taskId, taskDescription, open, onClose, onDone }: DriveSearchProps) {
  const t = useTranslations("tasks.actions");
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [summarizing, setSummarizing] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const hasSearched = useRef(false);

  async function handleSearch() {
    setLoading(true);
    setFiles([]);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Get Drive credentials
      const { data: cred } = await supabase
        .from("user_credentials")
        .select("access_token")
        .eq("user_id", user.id)
        .eq("service", "google_drive")
        .single();

      if (!cred) throw new Error("Drive not connected");

      // Extract keywords using simple approach (first 5 significant words)
      const keywords = taskDescription
        .replace(/[^\w\sא-ת]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 5)
        .join(" ");

      // Search Drive
      const query = encodeURIComponent(`fullText contains '${keywords}'`);
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,webViewLink,mimeType)&pageSize=10`,
        { headers: { Authorization: `Bearer ${cred.access_token}` } }
      );

      if (!resp.ok) throw new Error(`Drive API: ${resp.status}`);
      const data = await resp.json();
      setFiles(data.files || []);
      setSearched(true);

      // Save linked docs to task via Express
      if (data.files?.length) {
        const { task } = await api<{ task: { linked_drive_docs: Array<{ url: string; name: string }> | null } }>(`/api/tasks/${taskId}`);
        const existing = task.linked_drive_docs ?? [];
        const newDocs = data.files.map((f: DriveFile) => ({
          name: f.name,
          url: f.webViewLink,
        }));
        const existingUrls = new Set(existing.map((d) => d.url));
        const merged = [...existing, ...newDocs.filter((d: { url: string }) => !existingUrls.has(d.url))];

        await api(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: { linked_drive_docs: merged },
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Auto-search on open — keep render-side effects out of the body
  useEffect(() => {
    if (open && !hasSearched.current) {
      hasSearched.current = true;
      handleSearch();
    }
    if (!open) {
      hasSearched.current = false;
    }
    // handleSearch is stable enough for this single-shot trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSummarize(file: DriveFile) {
    setSummarizing(file.id);
    try {
      const { result } = await api<{ result: string }>("/api/quick-action", {
        method: "POST",
        body: {
          prompt: `Briefly summarize this document in 2-3 sentences in Hebrew based on its name only (you cannot fetch the URL).
Name: "${file.name}"
Type: ${file.mimeType}
URL: ${file.webViewLink}`,
          max_tokens: 300,
          model: "haiku",
        },
      });

      // Save summary to linked_drive_docs via Express
      const { task } = await api<{ task: { linked_drive_docs: Array<{ url: string; name: string; summary?: string }> | null } }>(`/api/tasks/${taskId}`);
      const docs = (task.linked_drive_docs ?? []).map((d) =>
        d.url === file.webViewLink ? { ...d, summary: result } : d
      );

      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: { linked_drive_docs: docs },
      });

      toast.success("Summary generated");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSummarizing(null);
    }
  }

  function handleClose() {
    setFiles([]);
    setSearched(false);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent side="bottom" className="h-auto max-h-[60vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="text-start gap-2 flex items-center">
            <FolderSearch className="h-5 w-5" />
            {t("searchDocs")}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-auto py-4">
          {loading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-green-600" />
              <p className="text-sm text-muted-foreground">{t("searchDocs")}...</p>
            </div>
          )}

          {searched && !loading && files.length === 0 && (
            <div className="py-8 text-center text-muted-foreground">
              <p>No documents found</p>
            </div>
          )}

          {files.length > 0 && (
            <div className="space-y-2">
              {files.map((file) => (
                <a
                  key={file.id}
                  href={file.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent"
                >
                  <FolderSearch className="h-5 w-5 text-blue-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" dir="auto">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{file.mimeType}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.preventDefault(); handleSummarize(file); }}
                      disabled={summarizing === file.id}
                      className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-primary"
                      title="Generate AI summary"
                    >
                      {summarizing === file.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="border-t pt-3 pb-[env(safe-area-inset-bottom)]">
          <Button variant="outline" onClick={handleClose} className="w-full min-h-[48px]">
            {searched ? "Done" : "Close"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
