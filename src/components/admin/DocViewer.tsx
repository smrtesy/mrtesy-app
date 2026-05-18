"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DocViewer({ content, filename }: { content: string; filename: string }) {
  function handleDownload() {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
      <Download className="h-3.5 w-3.5" />
      הורד .md
    </Button>
  );
}
