"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, FolderSearch, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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

      // Save linked docs to task
      if (data.files?.length) {
        const { data: task } = await supabase
          .from("tasks")
          .select("linked_drive_docs")
          .eq("id", taskId)
          .eq("user_id", user.id)
          .single();

        const existing = task?.linked_drive_docs || [];
        const newDocs = data.files.map((f: DriveFile) => ({
          name: f.name,
          url: f.webViewLink,
        }));
        // Merge without duplicates
        const existingUrls = new Set(existing.map((d: { url: string }) => d.url));
        const merged = [...existing, ...newDocs.filter((d: { url: string }) => !existingUrls.has(d.url))];

        await supabase.from("tasks").update({
          linked_drive_docs: merged,
          updated_at: new Date().toISOString(),
        }).eq("id", taskId);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Auto-search on open
  if (open && !loading && !searched) {
    // Use setTimeout to avoid calling during render
    setTimeout(handleSearch, 0);
  }

  async function handleSummarize(file: DriveFile) {
    setSummarizing(file.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/quick-action`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            action_label: "doc_summary",
            prompt: `Read this document and provide a brief summary (2-3 sentences in Hebrew) of what it contains. Document name: "${file.name}" (${file.mimeType}). URL: ${file.webViewLink}`,
          }),
        }
      );
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      // Save summary to linked_drive_docs
      const { data: task } = await supabase
        .from("tasks")
        .select("linked_drive_docs")
        .eq("id", taskId)
        .single();

      const docs = (task?.linked_drive_docs || []).map((d: { url: string; name: string; summary?: string }) =>
        d.url === file.webViewLink ? { ...d, summary: data.result } : d
      );

      await supabase.from("tasks").update({
        linked_drive_docs: docs,
        updated_at: new Date().toISOString(),
      }).eq("id", taskId);

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
                    <p className="text-sm font-medium truncate">{file.name}</p>
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
