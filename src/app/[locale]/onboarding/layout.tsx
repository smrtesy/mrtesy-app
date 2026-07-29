import { createClient } from "@/lib/supabase/server";
import { OnboardingHeader } from "@/components/platform/onboarding/OnboardingHeader";
import { BrandWordmark } from "@/components/platform/branding/BrandWordmark";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen flex-col items-center bg-muted px-4 py-6">
      <div className="mb-6 text-center">
        <h1 className="text-3xl text-primary">
          <BrandWordmark />
        </h1>
      </div>
      {user?.email && <OnboardingHeader email={user.email} />}
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
