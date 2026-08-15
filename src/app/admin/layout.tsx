import { ClerkProvider } from "@clerk/nextjs";

/**
 * Clerk is mounted here — on the /admin subtree only — rather than in the root
 * layout, so the public booking flow never loads Clerk. `force-dynamic` applies
 * to the whole segment: admin pages resolve the signed-in user per request and
 * must never be statically prerendered (which would also require Clerk keys at
 * build time).
 */
export const dynamic = "force-dynamic";

export default function AdminClerkLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
