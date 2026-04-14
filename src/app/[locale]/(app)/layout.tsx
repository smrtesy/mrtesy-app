import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/login`);
  }

  // Check onboarding
  const { data: settings } = await supabase
    .from("user_settings")
    .select("onboarding_completed")
    .eq("user_id", user.id)
    .single();

  if (!settings?.onboarding_completed) {
    redirect(`/${locale}/onboarding`);
  }

  const adminEmails = (process.env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = adminEmails.includes(user.email?.toLowerCase() || "");

  return (
    <div className="flex min-h-screen">
      {/* Desktop Sidebar */}
      <Sidebar locale={locale} isAdmin={isAdmin} />
      {/* Main content */}
      <main className="flex-1 pb-20 md:pb-0 md:ms-64">
        <div className="mx-auto max-w-4xl p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
