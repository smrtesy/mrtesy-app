"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  size?: "sm" | "md";
}

/**
 * Round avatar derived from the user's Google profile. Falls back to the
 * first letter of the email when no picture is available (or while the
 * image is loading and might fail). Click target is /account.
 */
export function UserAvatarLink({ className, size = "md" }: Props) {
  const { locale } = useParams() as { locale: string };
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [initial, setInitial] = useState<string>("?");
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
        "?";
      setInitial(source.trim().charAt(0).toUpperCase() || "?");
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const dim = size === "sm" ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-sm";

  return (
    <Link
      href={`/${locale}/account`}
      aria-label="Account settings"
      className={cn(
        "inline-flex items-center justify-center rounded-full overflow-hidden border bg-primary/10 text-primary font-semibold shrink-0 hover:ring-2 hover:ring-primary/30 transition",
        dim,
        className,
      )}
    >
      {avatarUrl && !imgFailed ? (
        // Use a plain img to skip next/image domain config and keep the
        // header lightweight; the avatar is small and rarely changes.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>{initial}</span>
      )}
    </Link>
  );
}
