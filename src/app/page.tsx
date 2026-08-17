import Link from "next/link";
import { ArrowRight, CalendarCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { tenantIndexEnabled } from "@/lib/tenant-index";
import { getAllTenants } from "@/lib/tenants";
import type { Tenant } from "@/lib/types";

/**
 * Kept `force-dynamic` deliberately, even though the production render below
 * reads nothing (ALI-176 criterion 3). The route is rendered per request, so no
 * build can ever bake a tenant list into a static artifact — if the gate is one
 * day loosened, the blast radius stays "this request", not "every request until
 * the next deploy". The gated-off path issues no query, so there is nothing to
 * cache anyway.
 */
export const dynamic = "force-dynamic";

/**
 * Platform root. This app is addressed per tenant at `/<slug>`; the tenant list
 * below is a **development-only** index, gated by `tenantIndexEnabled()`.
 *
 * In production the root renders the header and nothing else: no tenant name,
 * no slug, and no query — `getAllTenants()` is not called at all, so the
 * absence does not depend on the render being tidy. See `tenantIndexEnabled`
 * for why the gate is a single positive condition.
 */
export default async function HomePage() {
  const tenants = tenantIndexEnabled() ? await getAllTenants() : null;

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

      {tenants !== null && <TenantIndex tenants={tenants} />}
    </main>
  );
}

/**
 * The development index. Not exported: nothing outside this file should be able
 * to render a tenant list, and a page module's exports are its route contract.
 */
function TenantIndex({ tenants }: { tenants: Tenant[] }) {
  return (
    <>
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
    </>
  );
}
