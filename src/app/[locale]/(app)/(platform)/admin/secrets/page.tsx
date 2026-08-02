import { ManagedSecretsClient } from "@/components/admin/ManagedSecretsClient";

// Super-admin only. The whole /admin tree is gated by
// (platform)/admin/layout.tsx (server-side super_admins check), which mirrors the
// Express requireSuperAdmin on /api/admin/secrets/*. This page just renders the
// client; all data flows through the api() helper inside it.
export default function AdminSecretsPage() {
  return <ManagedSecretsClient />;
}
