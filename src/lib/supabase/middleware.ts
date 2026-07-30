import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { withTimeout } from "@/lib/withTimeout";

// Cap the auth-server round-trip so a slow/unreachable Supabase can never hang
// the middleware to a 504. Normal getUser() is well under this; only genuine
// degradation trips it.
const GET_USER_TIMEOUT_MS = 1500;

function getCookieDomain(): string | undefined {
  const domain = process.env.NEXT_PUBLIC_APP_DOMAIN;
  if (!domain || domain === "localhost" || domain.includes("localhost")) return undefined;
  return `.${domain}`; // e.g. '.smrtesy.com'
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const cookieDomain = getCookieDomain();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              ...(cookieDomain ? { domain: cookieDomain } : {}),
            })
          );
        },
      },
    }
  );

  // Fail OPEN on timeout/error: we return user=null but signal authTimedOut so
  // the middleware knows auth is *undetermined* (not *definitely logged out*)
  // and skips the login redirect instead of bouncing a real logged-in user.
  let user = null;
  let authTimedOut = false;
  try {
    const {
      data: { user: resolvedUser },
    } = await withTimeout(supabase.auth.getUser(), GET_USER_TIMEOUT_MS);
    user = resolvedUser;
  } catch {
    authTimedOut = true;
  }

  return { supabase, user, authTimedOut, response: supabaseResponse };
}

