import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

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

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicAdminRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  // Run on the /admin index AND every nested admin route — `auth()` throws in a
  // page/layout if clerkMiddleware didn't run on that request, so the exact
  // `/admin` path must be covered too.
  matcher: ["/admin", "/admin/:path*"],
};
