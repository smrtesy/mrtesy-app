import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { InviteSignIn } from "./InviteSignIn";
import { Building2, Clock } from "lucide-react";

interface InviteRow {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  org_id: string;
}

interface OrgRow {
  name: string;
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("invite");

  const admin = createAdminSupabaseClient();
  if (!admin) return notFound();

  const { data: invite } = await admin
    .from("org_invites")
    .select("id, email, role, expires_at, accepted_at, org_id")
    .eq("token", token)
    .maybeSingle<InviteRow>();

  if (!invite) return notFound();

  if (invite.accepted_at) {
    return (
      <div className="w-full max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-bold text-[#1E4D8C]">smrtTask</h1>
        <p className="text-muted-foreground">{t("alreadyAccepted")}</p>
      </div>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <div className="w-full max-w-sm space-y-6 text-center">
        <h1 className="text-2xl font-bold text-[#1E4D8C]">smrtTask</h1>
        <p className="text-muted-foreground">{t("expired")}</p>
      </div>
    );
  }

  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", invite.org_id)
    .maybeSingle<OrgRow>();

  const roleLabel = t(`role_${invite.role}` as "role_member" | "role_admin" | "role_owner");

  return (
    <div className="w-full max-w-sm space-y-8">
      <div className="text-center space-y-1">
        <h1 className="text-3xl font-bold text-[#1E4D8C]">smrtTask</h1>
      </div>

      <div className="rounded-xl border bg-card p-6 space-y-4 text-center shadow-sm">
        <Building2 className="mx-auto h-10 w-10 text-[#1E4D8C]" />
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-muted-foreground text-sm mt-1">
            {t("orgLabel")}: <span className="font-medium text-foreground">{org?.name ?? "—"}</span>
          </p>
          <p className="text-muted-foreground text-sm">
            {t("roleLabel")}: <span className="font-medium text-foreground">{roleLabel}</span>
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("emailHint", { email: invite.email })}
        </p>
        <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>{t("expiresAt", { date: new Date(invite.expires_at).toLocaleDateString() })}</span>
        </div>
      </div>

      <InviteSignIn />

      <p className="text-center text-xs text-muted-foreground">{t("googleHint")}</p>
    </div>
  );
}
