import Link from "next/link";
import { ArrowRight, CalendarCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getAllTenants } from "@/lib/tenants";

// Reads tenants from Supabase at request time.
export const dynamic = "force-dynamic";

/**
 * Platform root. This app is normally addressed per tenant at `/<slug>`; this
 * page is an internal index that links to the tenants so the multi-tenant,
 * white-label behavior is easy to see during development.
 */
export default async function HomePage() {
  const tenants = await getAllTenants();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-4 py-16">
      <div className="mb-10 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
          <CalendarCheck className="size-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Booking Platform
        </h1>
        <p className="mx-auto mt-2 max-w-md text-balance text-muted-foreground">
          One centrally-hosted, white-labeled booking experience that every
          customer site embeds at{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
            /your-slug
          </code>
          .
        </p>
      </div>

      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tenants
      </p>
      {tenants.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No tenants yet. Add one to the <code>customers</code> table to see it
          here.
        </p>
      )}
      <div className="grid gap-3">
        {tenants.map((tenant) => (
          <Card key={tenant.id} className="transition-shadow hover:shadow-md">
            <CardContent className="flex items-center gap-4 p-4">
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ backgroundColor: tenant.branding.brandColor }}
              >
                {tenant.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{tenant.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  /{tenant.slug}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/${tenant.slug}`}>
                  Open
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
