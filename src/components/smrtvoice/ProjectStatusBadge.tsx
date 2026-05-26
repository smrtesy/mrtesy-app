"use client";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "next-intl";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft:        "outline",
  parsed:       "outline",
  ready:        "secondary",
  queued:       "secondary",
  processing:   "default",
  audio_ready:  "default",
  completed:    "default",
  archiving:    "secondary",
  archived:     "outline",
  failed:       "destructive",
};

export function ProjectStatusBadge({ status }: { status: string }) {
  const t = useTranslations("smrtVoice.projects.status");
  const variant = STATUS_VARIANT[status] ?? "outline";
  let label: string;
  try {
    label = t(status as never);
  } catch {
    label = status;
  }
  return <Badge variant={variant}>{label}</Badge>;
}
