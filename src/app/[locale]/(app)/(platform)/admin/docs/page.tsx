import { readFileSync } from "fs";
import { join } from "path";
import { DocViewer } from "@/components/admin/DocViewer";

export default function AdminDocsPage() {
  const filePath = join(process.cwd(), "docs", "new-app-guide.md");
  const content = readFileSync(filePath, "utf-8");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">מדריך: הוספת אפליקציה חדשה</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            docs/new-app-guide.md — תיעוד פנימי עבור Claude Code
          </p>
        </div>
        <DocViewer content={content} filename="new-app-guide.md" />
      </div>

      <pre className="rounded-lg border bg-muted/40 p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[75vh] whitespace-pre-wrap break-words">
        {content}
      </pre>
    </div>
  );
}
