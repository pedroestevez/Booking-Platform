import type { Metadata } from "next";

import { ServiceForm } from "@/components/admin/service-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { resolveAdminContext } from "@/lib/admin/auth";
import { listServices } from "@/lib/admin/config";
import { formatDuration, formatServicePrice } from "@/lib/utils";
import {
  createServiceAction,
  setServiceActiveAction,
  updateServiceAction,
} from "./actions";

export const metadata: Metadata = { title: "Services" };

export default async function AdminServicesPage() {
  const { tenant } = await resolveAdminContext();
  const services = await listServices(tenant.id);
  const { currency } = tenant.branding;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What guests can book. Inactive services are hidden from the public page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a service</CardTitle>
          <CardDescription>New services are active by default.</CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceForm
            action={createServiceAction}
            currency={currency}
            submitLabel="Add service"
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Your services{" "}
          <span className="font-normal text-muted-foreground/70">
            ({services.length})
          </span>
        </h2>

        {services.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No services yet — add your first one above.
            </CardContent>
          </Card>
        ) : (
          services.map((service) => (
            <Card key={service.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="truncate">{service.name}</span>
                    {service.active ? (
                      <Badge variant="default">Active</Badge>
                    ) : (
                      <Badge variant="muted">Inactive</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {formatDuration(service.durationMinutes)} ·{" "}
                    {formatServicePrice(service.priceCents, currency)}
                  </CardDescription>
                </div>
                <form
                  action={setServiceActiveAction.bind(
                    null,
                    service.id,
                    !service.active,
                  )}
                >
                  <Button type="submit" variant="outline" size="sm">
                    {service.active ? "Deactivate" : "Activate"}
                  </Button>
                </form>
              </CardHeader>
              <CardContent>
                <details className="group">
                  <summary className="cursor-pointer list-none text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
                    <span className="group-open:hidden">Edit ↓</span>
                    <span className="hidden group-open:inline">Close ↑</span>
                  </summary>
                  <div className="mt-4">
                    <ServiceForm
                      action={updateServiceAction.bind(null, service.id)}
                      service={service}
                      currency={currency}
                      submitLabel="Save changes"
                    />
                  </div>
                </details>
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
