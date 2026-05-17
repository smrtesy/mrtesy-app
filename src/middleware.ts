import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const intlMiddleware = createMiddleware({
  locales: ["he", "en"],
  defaultLocale: "he",
  localeDetection: true,
});

const RESERVED_SUBDOMAINS = new Set(["app", "www", "api", "mail", "smtp", "cdn"]);

/**
 * Extract the org slug from the host if it's a tenant subdomain.
 * Returns null on localhost, main domain, reserved subdomains, or 'app'.
 * Returns the subdomain string for org subdomains (e.g. 'maor' from 'maor.smrtesy.com').
 * Returns 'app' specifically when the subdomain is the platform admin subdomain.
 */
function extractSubdomain(host: string): { orgSlug: string | null; isPlatform: boolean } {
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN;
  if (!appDomain || host === appDomain || host === `www.${appDomain}` || host.startsWith("localhost")) {
    return { orgSlug: null, isPlatform: false };
  }
  if (!host.endsWith(`.${appDomain}`)) {
    return { orgSlug: null, isPlatform: false };
  }
  const sub = host.slice(0, -(appDomain.length + 1));
  if (sub === "app") return { orgSlug: null, isPlatform: true };
  if (RESERVED_SUBDOMAINS.has(sub)) return { orgSlug: null, isPlatform: false };
  return { orgSlug: sub, isPlatform: false };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") || "";
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN;

  // Skip API routes and static files
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  const { orgSlug, isPlatform } = extractSubdomain(host);

  // Update Supabase session (mutates request.cookies in place)
  const { user, supabase, response } = await updateSession(request);

  // Unknown org subdomain → redirect to main app
  if (orgSlug) {
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .eq("slug", orgSlug)
      .maybeSingle();

    if (!org) {
      const target = appDomain ? `https://app.${appDomain}` : new URL("/", request.url).toString();
      return NextResponse.redirect(target);
    }

    // Org found — write the org ID into request cookies so the layout and
    // server components can read it via `cookies()` from next/headers.
    request.cookies.set("smrt_org_id", org.id);
    request.cookies.set("smrt_org_slug", orgSlug);
  } else {
    // Not an org subdomain — clear any stale org cookie from request
    request.cookies.delete("smrt_org_id");
    request.cookies.delete("smrt_org_slug");
  }

  // Dev auth bypass
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

  // Extract locale
  const pathnameLocale = pathname.split("/")[1];
  const hasLocalePrefix = pathnameLocale === "he" || pathnameLocale === "en";
  const locale = hasLocalePrefix ? pathnameLocale : "he";

  // Prefer saved language for entry URLs
  if (!hasLocalePrefix && user) {
    const { data: settings } = await supabase
      .from("user_settings")
      .select("preferred_language")
      .eq("user_id", user.id)
      .maybeSingle();
    const pref = settings?.preferred_language;
    if (pref === "he" || pref === "en") {
      const target = new URL(
        `/${pref}${pathname === "/" ? "" : pathname}${request.nextUrl.search}`,
        request.url,
      );
      const redirectResp = NextResponse.redirect(target);
      response.cookies.getAll().forEach((cookie) => {
        redirectResp.cookies.set(cookie.name, cookie.value, { ...cookie });
      });
      return redirectResp;
    }
  }

  // Admin route protection
  const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdminRoute = pathname.includes("/admin");
  if (isAdminRoute) {
    if (!user) {
      return NextResponse.redirect(new URL(`/${locale}/login`, request.url));
    }
    const emailMatches = ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
    let hasAccess = emailMatches;
    if (!hasAccess) {
      const { data: row } = await supabase
        .from("super_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      hasAccess = !!row;
    }
    if (!hasAccess) {
      return NextResponse.redirect(new URL(`/${locale}`, request.url));
    }
  }

  // Protected route check
  const isPublicRoute = pathname.includes("/login") || pathname.includes("/onboarding") || pathname.includes("/invite/");
  if (!isPublicRoute && !isAdminRoute && user === null) {
    const localePrefix = pathnameLocale === "en" ? "/en" : "/he";
    if (
      pathname !== `${localePrefix}/login` &&
      pathname !== `${localePrefix}` &&
      pathname !== "/" &&
      pathname !== `${localePrefix}/`
    ) {
      return NextResponse.redirect(new URL(`${localePrefix}/login`, request.url));
    }
  }

  // Redirect logged-in users from login to home
  if (pathname.includes("/login") && user) {
    const localePrefix = pathnameLocale === "en" ? "/en" : "/he";
    return NextResponse.redirect(new URL(`${localePrefix}`, request.url));
  }

  // Apply i18n middleware (uses the mutated request, so it will see smrt_org_id cookie)
  const intlResponse = intlMiddleware(request);

  // Copy Supabase session cookies to intl response
  response.cookies.getAll().forEach((cookie) => {
    intlResponse.cookies.set(cookie.name, cookie.value, { ...cookie });
  });

  // Persist the org cookie in the browser response (scoped to this subdomain, not parent)
  if (orgSlug) {
    const orgId = request.cookies.get("smrt_org_id")?.value;
    if (orgId) {
      intlResponse.cookies.set("smrt_org_id", orgId, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24, // 24 h
      });
      intlResponse.cookies.set("smrt_org_slug", orgSlug, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24,
      });
    }
  } else if (!orgSlug && !isPlatform) {
    // On main/app domain — clear any stale org cookies
    intlResponse.cookies.set("smrt_org_id", "", { path: "/", maxAge: 0 });
    intlResponse.cookies.set("smrt_org_slug", "", { path: "/", maxAge: 0 });
  }

  return intlResponse;
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
