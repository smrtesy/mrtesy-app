export const dynamic = "force-dynamic";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

export default async function AdminUsersPage({
  params: { locale },
}: {
  params: { locale: string };
}) {
  const supabase = createClient();

  const { data: users } = await supabase
    .from("user_settings")
    .select("user_id, plan, display_name, gmail_connected, drive_connected, whatsapp_connected, calendar_connected, onboarding_completed, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Users</h1>

      <div className="space-y-2">
        {(users || []).map((user) => (
          <Link
            key={user.user_id}
            href={`/${locale}/admin/users/${user.user_id}`}
            className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent"
          >
            <div>
              <p className="font-medium">{user.display_name || user.user_id.slice(0, 8)}</p>
              <p className="text-xs text-muted-foreground">{user.plan}</p>
            </div>
            <div className="flex gap-1">
              {user.gmail_connected && <Badge variant="outline" className="text-xs">Gmail</Badge>}
              {user.drive_connected && <Badge variant="outline" className="text-xs">Drive</Badge>}
              {user.whatsapp_connected && <Badge variant="outline" className="text-xs">WA</Badge>}
              {user.calendar_connected && <Badge variant="outline" className="text-xs">Cal</Badge>}
              {!user.onboarding_completed && <Badge variant="secondary" className="text-xs">Onboarding</Badge>}
            </div>
          </Link>
        ))}
        {(!users || users.length === 0) && (
          <p className="text-center text-muted-foreground py-8">No users yet</p>
        )}
      </div>
    </div>
  );
}
