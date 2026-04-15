import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!serviceRoleKey) {
    return NextResponse.json({ error: "No service role key" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Use the main user account (which has the tasks)
  const targetEmail = "chanoch770@gmail.com";

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetEmail,
  });

  if (linkError || !linkData) {
    return NextResponse.json({ error: linkError?.message }, { status: 500 });
  }

  const { data: session, error: verifyError } = await admin.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });

  if (verifyError || !session.session) {
    return NextResponse.json({ error: verifyError?.message || "No session" }, { status: 500 });
  }

  return NextResponse.json({
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
  });
}
