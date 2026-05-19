"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

function isChunkLoadError(error: Error) {
  return (
    error.name === "ChunkLoadError" ||
    error.message.includes("Loading chunk") ||
    error.message.includes("Failed to fetch dynamically imported module")
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App error:", error);
    // After a new deployment the old chunks no longer exist on the CDN.
    // Auto-reload so the browser fetches the fresh HTML + new chunk hashes.
    if (isChunkLoadError(error)) {
      window.location.reload();
    }
  }, [error]);

  if (isChunkLoadError(error)) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertTriangle className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-xl font-semibold">טוען מחדש…</h2>
        <p className="text-sm text-muted-foreground">עדכון זמין, הדף ייטען אוטומטית.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        {error.message || "An unexpected error occurred"}
      </p>
      <Button onClick={reset} className="min-h-[48px]">
        Try again
      </Button>
    </div>
  );
}
