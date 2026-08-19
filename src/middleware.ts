import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { isPlatformHost } from "@/lib/platform-host";
import { getTenantByHost } from "@/lib/tenants";

/**
 * Clerk runs ONLY on the /admin segment. Within /admin, every route is
 * protected except the sign-in and no-access pages, which an
 * unauthenticated/unmapped user must be able to reach.
 */
const isPublicAdminRoute = createRouteMatcher([
  "/admin/sign-in(.*)",
  "/admin/no-access",
]);

/**
 * A fresh 404 each call — `Response` bodies are single-use streams, so a
 * module-scoped constant reused across requests would fail the second time
 * anything (a test, a proxy) reads its body.
 */
function adminNotConfigured(): NextResponse {
  return new NextResponse(
    "Not found — the admin dashboard is not enabled on this deployment.",
    { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

/**
 * Header injected into the FORWARDED request (not the response) when a
 * request was routed via a tenant's custom domain rather than the platform's
 * own `/<slug>` route, so downstream `headers()` reads (the tenant page's
 * `generateMetadata` and component) can tell the two apart — ALI-115.
 */
const CUSTOM_DOMAIN_HEADER = "x-booking-custom-domain";

/** Lowercased request host, preferring the proxy-forwarded value. */
function requestHost(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""
  ).toLowerCase();
}

/**
 * Whether this deployment configured Clerk at all (ALI-208).
 *
 * Both keys, not either: `clerkMiddleware` asserts the publishable key on every
 * request and the server SDK needs the secret, so a half-configured deployment
 * fails exactly as loudly as an unconfigured one — just later, and with a
 * worse error. Read per-request rather than at module scope so the check
 * cannot be baked into a build and go stale.
 */
function isClerkConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  );
}

const withClerk = clerkMiddleware(async (auth, req) => {
  if (!isPublicAdminRoute(req)) {
    await auth.protect();
  }
});

/**
 * Absent Clerk keys, `clerkMiddleware` throws inside the request handler and
 * Vercel surfaces a raw `MIDDLEWARE_INVOCATION_FAILED` 500. That is the wrong
 * answer to "does this deployment have an admin dashboard": the honest answer
 * is no, and the HTTP word for no is 404, not "something broke".
 *
 * The distinction is not cosmetic. A 500 says the feature exists and is
 * broken — it invites a retry, and on a public demo it is the first thing a
 * technical visitor typing /admin will conclude. A 404 says the route is not
 * part of this deployment, which is true.
 *
 * Falling through to the page instead would not work: `auth()` throws in a
 * page or layout whenever `clerkMiddleware` did not run on that request, so an
 * un-wrapped request produces the same 500 one layer deeper. The refusal has
 * to happen here.
 *
 * Also true on a custom domain, for a different reason: `/admin` must never
 * be reachable at a tenant's own `booking.<their-domain>.com` address, even
 * when Clerk is fully configured on this deployment — a tenant's public host
 * has no business exposing the platform's shared admin login. Same response,
 * same status; the visitor sees no admin dashboard either way.
 */
function handleAdmin(req: NextRequest, event: NextFetchEvent) {
  if (!isClerkConfigured()) return adminNotConfigured();
  if (!isPlatformHost(requestHost(req))) return adminNotConfigured();
  return withClerk(req, event);
}

/**
 * Custom-domain tenant routing (ALI-115), for every non-`/admin` path.
 *
 * On the platform's own host, today's slug-based routing (`/<slug>`) is
 * untouched and `getTenantByHost` is never even called — zero added latency
 * or DB round-trip on the existing common path.
 *
 * Off the platform host, the incoming `Host` is looked up against
 * `customers.custom_domain`:
 *   - **found** → rewrite to `/<slug>` (or `/<slug>/<rest>` for a deeper
 *     path), carrying an `x-booking-custom-domain` header on the FORWARDED
 *     request so the tenant page can tell it was reached this way.
 *   - **not found** → a plain 404, and explicitly NOT a rewrite. This is the
 *     security-critical guard: an unrecognised host must never resolve to
 *     any tenant's data, wrong or arbitrary.
 *   - **lookup throws** → a 503, not a 404 and not a silent fallback — a
 *     lookup failure is not the same fact as "no such tenant".
 */
async function handlePublic(req: NextRequest): Promise<NextResponse> {
  const host = requestHost(req);
  if (isPlatformHost(host)) return NextResponse.next();

  let tenant;
  try {
    tenant = await getTenantByHost(host);
  } catch {
    return new NextResponse("Service unavailable", { status: 503 });
  }

  if (!tenant) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { pathname } = req.nextUrl;
  const url = req.nextUrl.clone();
  url.pathname = pathname === "/" ? `/${tenant.slug}` : `/${tenant.slug}${pathname}`;

  const headers = new Headers(req.headers);
  headers.set(CUSTOM_DOMAIN_HEADER, "1");

  return NextResponse.rewrite(url, { request: { headers } });
}

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return handleAdmin(req, event);
  }
  return handlePublic(req);
}

export const config = {
  // Everything except Next internals and static assets — public routes now
  // need to run through custom-domain tenant resolution too, not just
  // /admin. `/admin` itself stays covered: `auth()` throws in a page/layout
  // if clerkMiddleware didn't run on that request, so the exact `/admin`
  // path (not just its subpaths) must be matched.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml|woff2?|ttf)$).*)",
  ],
};
