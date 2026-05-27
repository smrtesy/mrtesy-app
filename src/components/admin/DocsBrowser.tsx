"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Doc {
  filename: string;
  content: string;
}

export function DocsBrowser({ docs }: { docs: Doc[] }) {
  const preferred = docs.findIndex((d) => d.filename === "new-app-guide.md");
  const [idx, setIdx] = useState(preferred >= 0 ? preferred : 0);

  if (docs.length === 0) {
    return <p className="text-sm text-muted-foreground">אין מסמכים.</p>;
  }

  const active = docs[idx] ?? docs[0];

  function handleDownload() {
    const blob = new Blob([active.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = active.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <nav className="flex flex-col gap-1">
        {docs.map((d, i) => (
          <button
            key={d.filename}
            onClick={() => setIdx(i)}
            title={d.filename}
            className={cn(
              "text-start rounded-md px-3 py-2 text-xs font-mono truncate transition-colors",
              i === idx
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {d.filename}
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <code className="text-xs text-muted-foreground truncate">docs/{active.filename}</code>
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5 shrink-0">
            <Download className="h-3.5 w-3.5" />
            הורד .md
          </Button>
        </div>
        <pre className="rounded-lg border bg-muted/40 p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[75vh] whitespace-pre-wrap break-words">
          {active.content}
        </pre>
      </div>
    </div>
  );
}
