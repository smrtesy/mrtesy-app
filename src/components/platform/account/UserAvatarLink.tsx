"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";

interface Props {
  className?: string;
  size?: "sm" | "md";
}

/**
 * Round avatar derived from the user's Google profile. Falls back through
 *  picture URL → first letter of name/email → generic user icon.
 * Click target is /account — opened as a workspace tab on desktop, or a normal
 * navigation on mobile / outside the workspace.
 */
export function UserAvatarLink({ className, size = "md" }: Props) {
  const { locale } = useParams() as { locale: string };
  const t = useTranslations("account");
  const workspace = useOptionalTabsWorkspace();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [initial, setInitial] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      const md = (user.user_metadata ?? {}) as Record<string, unknown>;
      const pic =
        (typeof md.avatar_url === "string" && md.avatar_url) ||
        (typeof md.picture === "string" && md.picture) ||
        null;
      setAvatarUrl(pic);
      const source =
        (typeof md.full_name === "string" && md.full_name) ||
        (typeof md.name === "string" && md.name) ||
        user.email ||
        "";
      const firstChar = source.trim().charAt(0).toUpperCase();
      setInitial(firstChar || null);
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const dim = size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-sm";

  const showImage = avatarUrl && !imgFailed;
  const showInitial = !showImage && initial;

  return (
    <Link
      href={`/${locale}/account`}
      aria-label={t("title")}
      onClick={(e) => {
        // On desktop, open account settings as a workspace pane instead of a
        // full-window navigation the panes would hide. Skip on narrow widths
        // (mobile / embedded panes) so it navigates normally there.
        if (
          workspace &&
          typeof window !== "undefined" &&
          window.matchMedia("(min-width: 768px)").matches
        ) {
          e.preventDefault();
          workspace.openTab(`/${locale}/account`, t("title"));
        }
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-full overflow-hidden border bg-primary/10 text-primary font-semibold shrink-0 hover:ring-2 hover:ring-primary/30 transition",
        dim,
        className,
      )}
    >
      {showImage ? (
        // Plain img to skip next/image domain config; the avatar is small
        // and rarely changes.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl!}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : showInitial ? (
        <span>{initial}</span>
      ) : (
        <User className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
      )}
    </Link>
  );
}
