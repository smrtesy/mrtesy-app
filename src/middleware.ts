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

  // Skip API routes, static files, and the public embeddable widget (/embed/*
  // is anonymous + locale-agnostic — it must not hit the auth/locale gates).
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/embed/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // ── Cold-start fast-paths ──────────────────────────────────────────────
  // A PWA launch on a phone pays a full cellular round-trip per redirect hop,
  // so collapse the "/" → "/he" → "/he/tasks" chain BEFORE the auth
  // round-trip below. Auth/session refresh simply happens on the request
  // that follows the redirect.
  //
  // (1) The locale home ("/he", "/en") redirects to /tasks — mirror of
  //     [locale]/page.tsx, one hop earlier. The locale in THIS url is not
  //     authoritative (see the saved-language block below): honor the saved
  //     preference when we have it cached, and fall through to the DB lookup
  //     when we don't ([locale]/page.tsx still redirects to /tasks, so the
  //     extra hop is safe).
  const localeRoot = pathname.match(/^\/(he|en)\/?$/);
  if (localeRoot) {
    const lang = request.cookies.get("smrt_lang_pref")?.value;
    if (lang === "he" || lang === "en") {
      return NextResponse.redirect(new URL(`/${lang}/tasks`, request.url));
    }
  }
  // (2) Root entry with a saved-language cookie: straight to the landing
  //     page in ONE redirect. A logged-out visitor with a stale cookie just
  //     bounces /tasks → login, same hop count as before.
  if (pathname === "/") {
    const lang = request.cookies.get("smrt_lang_pref")?.value;
    if (lang === "he" || lang === "en") {
      return NextResponse.redirect(new URL(`/${lang}/tasks`, request.url));
    }
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

  // ── Saved language wins on ENTRY urls ───────────────────────────────────
  // An "entry url" is how the app OPENS: a prefix-less path, the bare locale
  // root ("/he"), or the landing screen ("/he/tasks"). The locale inside such a
  // url is NOT authoritative — an installed PWA's cached start_url, a bookmark,
  // or a restored window all re-enter through one of them. Gating this lookup on
  // "has no locale prefix" (what it used to do) therefore pinned the app to that
  // url's locale permanently: switching to English reverted on every relaunch
  // even though user_settings.preferred_language already said "en".
  //
  // Deep links keep their explicit locale — they carry a deeper path or a query
  // string, so they never match here. That also excludes pane iframes (always
  // ?embed=1) and client-side RSC navigations (always ?_rsc=…).
  const isLandingEntry =
    !!localeRoot ||
    (hasLocalePrefix &&
      !request.nextUrl.search &&
      /^\/(he|en)\/tasks\/?$/.test(pathname));
  if ((!hasLocalePrefix || isLandingEntry) && user) {
    // A locale-prefixed entry url lands on the default screen; a prefix-less
    // deep path keeps the path it asked for.
    const entryPath = hasLocalePrefix || pathname === "/" ? "/tasks" : pathname;

    /** Redirect to `pref`, or null when that is the url we are already on —
     *  returning a redirect to the current path would loop forever. */
    const toPreferred = (pref: "he" | "en", persist: boolean) => {
      const path = `/${pref}${entryPath}`;
      if (path === pathname || path === pathname.replace(/\/$/, "")) return null;
      const redirectResp = NextResponse.redirect(
        new URL(`${path}${request.nextUrl.search}`, request.url),
      );
      response.cookies.getAll().forEach((cookie) => {
        redirectResp.cookies.set(cookie.name, cookie.value, { ...cookie });
      });
      if (persist) {
        redirectResp.cookies.set("smrt_lang_pref", pref, {
          path: "/",
          sameSite: "lax",
          maxAge: 60 * 60 * 24, // 24h
        });
      }
      return redirectResp;
    };

    // Fast path: the cookie mirrors the saved preference (24h) and skips the DB.
    const cachedLang = request.cookies.get("smrt_lang_pref")?.value;
    if (cachedLang === "he" || cachedLang === "en") {
      const resp = toPreferred(cachedLang, false);
      if (resp) return resp;
    } else {
      // Slow path: DB lookup on first visit or after cookie expiry.
      const { data: settings } = await supabase
        .from("user_settings")
        .select("preferred_language")
        .eq("user_id", user.id)
        .maybeSingle();
      const pref = settings?.preferred_language;
      if (pref === "he" || pref === "en") {
        const resp = toPreferred(pref, true);
        if (resp) return resp;
        // Already on the preferred locale — no redirect, but still cache the
        // preference, or every hard load of the landing screen would repeat this
        // DB round-trip inside the middleware. `response` is the updateSession
        // response and its cookies are copied onto the final response below.
        response.cookies.set("smrt_lang_pref", pref, {
          path: "/",
          sameSite: "lax",
          maxAge: 60 * 60 * 24, // 24h
        });
      }
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
  const isPublicRoute = pathname.includes("/login") || pathname.includes("/onboarding") || pathname.includes("/invite/") || pathname.includes("/privacy") || pathname.includes("/terms");
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
  matcher: ["/((?!_next|api|embed|.*\\..*).*)"],
};
