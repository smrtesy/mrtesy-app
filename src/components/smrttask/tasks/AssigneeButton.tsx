"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { User, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useOrgRole } from "@/hooks/useOrgRole";

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
}

// Members list is org-stable within a session — fetch once, share.
let cachedMembers: Member[] | null = null;
let inflight: Promise<Member[]> | null = null;
async function fetchMembers(): Promise<Member[]> {
  if (cachedMembers) return cachedMembers;
  if (!inflight) {
    inflight = api<{ members: Member[] }>("/api/org/members")
      .then((r) => { cachedMembers = r.members ?? []; return cachedMembers; })
      .catch(() => { inflight = null; return []; });
  }
  return inflight;
}

function memberName(m: Member): string {
  return m.display_name || m.name || m.email || m.user_id.slice(0, 8);
}

/**
 * Person-icon assignee control. Manager-only (org owner/admin) — for everyone
 * else it renders nothing, since assigning tasks to others is a manager action
 * (enforced again on the server). Filled when the task is assigned. The member
 * list is org-scoped on the backend, so a manager only ever sees their own org.
 */
export function AssigneeButton({
  assignedTo,
  onAssign,
  className,
}: {
  assignedTo: string | null;
  onAssign: (userId: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("taskDetailExt");
  const { isManager } = useOrgRole();
  const [members, setMembers] = useState<Member[]>(cachedMembers ?? []);

  const load = useCallback(() => {
    if (members.length === 0) fetchMembers().then(setMembers);
  }, [members.length]);

  useEffect(() => {
    // Preload so the assigned name is resolvable on first paint.
    if (isManager) fetchMembers().then(setMembers);
  }, [isManager]);

  if (!isManager) return null;

  const assigned = assignedTo ? members.find((m) => m.user_id === assignedTo) : null;
  const label = assigned ? t("assignedTo", { name: memberName(assigned) }) : t("assignLabel");

  return (
    <DropdownMenu onOpenChange={(o) => o && load()}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={label}
          color="primary"
          className={cn(assignedTo ? "text-primary" : undefined, className)}
        >
          <User className={assignedTo ? "fill-current" : undefined} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onAssign(null)} className="gap-2">
          <span className="flex-1">{t("unassignedOption")}</span>
          {!assignedTo && <Check className="h-3.5 w-3.5" />}
        </DropdownMenuItem>
        {members.map((m) => (
          <DropdownMenuItem key={m.user_id} onSelect={() => onAssign(m.user_id)} className="gap-2">
            <span className="flex-1 truncate">{memberName(m)}</span>
            {assignedTo === m.user_id && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
