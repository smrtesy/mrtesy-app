"use client";

import { useState } from "react";
import { Building2, Check, ChevronsUpDown, Plus, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveOrg } from "@/lib/api/use-active-org";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  locale: string;
}

export function OrgSwitcher({ locale }: Props) {
  const { orgs, active, loading, switchOrg, refresh } = useActiveOrg();
  const isHe = locale === "he";

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const { org } = await api<{ org: { id: string } }>("/api/orgs", {
        method: "POST",
        body: { name: newName.trim() },
        noOrg: true,
      });
      switchOrg(org.id);
      toast.success(isHe ? "ארגון נוצר" : "Organization created");
      setNewName("");
      setCreateOpen(false);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return <Skeleton className="h-9 w-full" />;
  }

  if (orgs.length === 0) return null;

  const displayName = (org: typeof orgs[number]) =>
    isHe && org.name_he ? org.name_he : org.name;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between gap-2 h-9"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-start" dir="auto">
                {active ? displayName(active) : (isHe ? "בחר ארגון" : "Select org")}
              </span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          {orgs.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onClick={() => switchOrg(org.id)}
              className="gap-2"
            >
              <Check className={cn(
                "h-4 w-4 shrink-0",
                org.id === active?.id ? "opacity-100" : "opacity-0",
              )} />
              <span className="flex-1 truncate" dir="auto">{displayName(org)}</span>
              <span className="text-[10px] text-muted-foreground uppercase">{org.role}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            <span>{isHe ? "ארגון חדש" : "New organization"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isHe ? "ארגון חדש" : "New organization"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={isHe ? "שם הארגון" : "Organization name"}
              dir="auto"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="w-full gap-2"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {isHe ? "צור" : "Create"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
