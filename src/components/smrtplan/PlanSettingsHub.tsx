"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { UserCog, CalendarClock, LayoutTemplate, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RolesSection } from "./RolesEditor";
import { CapacitySection } from "./CapacityEditor";
import { TemplatesSection } from "./TemplatesEditor";
import { EstimatesSection } from "./EstimatesEditor";

export type PlanSettingsTab = "roles" | "capacity" | "templates" | "estimates";

/** One dialog for all planning setup — roles, team capacity, templates and
 *  hour estimates — instead of a separate modal per topic. Tab order follows
 *  the natural setup order (people first, then reusable building blocks). */
export function PlanSettingsHub({
  open,
  initialTab = "roles",
  onClose,
  onChanged,
}: {
  open: boolean;
  initialTab?: PlanSettingsTab;
  onClose: () => void;
  /** Fired when templates change (the board's quick-add list depends on them). */
  onChanged?: () => void;
}) {
  const t = useTranslations("smrtPlan");
  const [tab, setTab] = useState<PlanSettingsTab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const tabs: { id: PlanSettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "roles", label: t("roles.button"), icon: <UserCog className="h-3.5 w-3.5" /> },
    { id: "capacity", label: t("capacity.button"), icon: <CalendarClock className="h-3.5 w-3.5" /> },
    { id: "templates", label: t("templates.button"), icon: <LayoutTemplate className="h-3.5 w-3.5" /> },
    { id: "estimates", label: t("estimates.button"), icon: <Timer className="h-3.5 w-3.5" /> },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1 rounded-lg border bg-secondary/40 p-1">
          {tabs.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        {/* All sections stay mounted (hidden) so switching tabs doesn't discard
            a half-typed draft; closing the dialog unmounts everything. */}
        <div className={cn(tab !== "roles" && "hidden")}><RolesSection /></div>
        <div className={cn(tab !== "capacity" && "hidden")}><CapacitySection /></div>
        <div className={cn(tab !== "templates" && "hidden")}><TemplatesSection onChanged={onChanged} /></div>
        <div className={cn(tab !== "estimates" && "hidden")}><EstimatesSection /></div>
      </DialogContent>
    </Dialog>
  );
}
