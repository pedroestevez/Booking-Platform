import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

/**
 * Clerk runs ONLY on the /admin segment. The customer-facing booking flow (and
 * its iframe embed) is intentionally Clerk-free — no auth JS, no middleware
 * overhead — so the `matcher` below excludes everything except `/admin/*`.
 *
 * Within /admin, every route is protected except the sign-in and no-access
 * pages, which an unauthenticated/unmapped user must be able to reach.
 */
const isPublicAdminRoute = createRouteMatcher([
  "/admin/sign-in(.*)",
  "/admin/no-access",
]);

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
 */
export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!isClerkConfigured()) {
    return new NextResponse(
      "Not found — the admin dashboard is not enabled on this deployment.",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return withClerk(req, event);
}

export const config = {
  // Run on the /admin index AND every nested admin route — `auth()` throws in a
  // page/layout if clerkMiddleware didn't run on that request, so the exact
  // `/admin` path must be covered too.
  matcher: ["/admin", "/admin/:path*"],
};
