import type { Metadata } from "next";
import { SignOutButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "No access",
  robots: { index: false, follow: false },
};

/**
 * Reached when a user is signed in but their Clerk identity isn't linked to any
 * tenant (`tenant_members`). Linking is a deliberate, server-side step — an
 * owner is granted access by inserting a membership row — so we don't self-serve
 * provisioning here.
 */
export default function NoAccessPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-4 py-12 text-center">
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          No business linked to this account
        </h1>
        <p className="text-sm text-muted-foreground">
          You&rsquo;re signed in, but this account isn&rsquo;t connected to a
          booking business yet. If you expected access, ask your administrator to
          add you, then sign in again.
        </p>
      </div>
      <SignOutButton redirectUrl="/admin/sign-in">
        <Button variant="outline">Sign out</Button>
      </SignOutButton>
    </div>
  );
}
