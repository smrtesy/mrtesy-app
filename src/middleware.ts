import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const intlMiddleware = createMiddleware({
  locales: ["he", "en"],
  defaultLocale: "he",
  localeDetection: true,
});

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip API routes and static files
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Update Supabase session
  const { user, response } = await updateSession(request);

  // Dev auth bypass — skip all auth redirects on localhost
  const devBypass =
    process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "true" &&
    process.env.NODE_ENV === "development";
  if (devBypass && !user) {
    const intlResponse = intlMiddleware(request);
    response.cookies.getAll().forEach((cookie) => {
      intlResponse.cookies.set(cookie.name, cookie.value, { ...cookie });
    });
    return intlResponse;
  }

  // Extract locale from path
  const pathnameLocale = pathname.split("/")[1];
  const locale =
    pathnameLocale === "he" || pathnameLocale === "en" ? pathnameLocale : "he";

  // Admin route protection
  const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdminRoute = pathname.includes("/admin");
  if (isAdminRoute) {
    if (!user) {
      return NextResponse.redirect(new URL(`/${locale}/login`, request.url));
    }
    if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(user.email?.toLowerCase() || "")) {
      return NextResponse.redirect(new URL(`/${locale}`, request.url));
    }
  }

  // Check if it's actually a protected page (not login/onboarding)
  const isPublicRoute =
    pathname.includes("/login") || pathname.includes("/onboarding");

  if (!isPublicRoute && !isAdminRoute && user === null) {
    // Redirect to login if not authenticated and trying to access protected route
    const localePrefix = pathnameLocale === "en" ? "/en" : "/he";
    if (
      pathname !== `${localePrefix}/login` &&
      pathname !== `${localePrefix}` &&
      pathname !== "/" &&
      pathname !== `${localePrefix}/`
    ) {
      return NextResponse.redirect(
        new URL(`${localePrefix}/login`, request.url)
      );
    }
  }

  // Redirect logged-in users from login to home
  if (pathname.includes("/login") && user) {
    const localePrefix = pathnameLocale === "en" ? "/en" : "/he";
    return NextResponse.redirect(new URL(`${localePrefix}`, request.url));
  }

  // Apply i18n middleware
  const intlResponse = intlMiddleware(request);

  // Copy Supabase cookies to intl response
  response.cookies.getAll().forEach((cookie) => {
    intlResponse.cookies.set(cookie.name, cookie.value, {
      ...cookie,
    });
  });

  return intlResponse;
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
