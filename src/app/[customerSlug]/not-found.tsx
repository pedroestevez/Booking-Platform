import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function TenantNotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        We couldn&apos;t find that booking page
      </h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The link may be mistyped, or this business hasn&apos;t set up booking
        yet. Double-check the address and try again.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link href="/">Go home</Link>
      </Button>
    </div>
  );
}
