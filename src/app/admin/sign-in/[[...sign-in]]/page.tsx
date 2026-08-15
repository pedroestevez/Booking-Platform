import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function AdminSignInPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-12">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Admin
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to manage your bookings.
        </p>
      </div>
      <SignIn />
    </div>
  );
}
