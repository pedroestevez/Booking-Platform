import type { Metadata } from "next";

import { BookingStatusBadge } from "@/components/admin/booking-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { resolveAdminContext } from "@/lib/admin/auth";
import { getAdminBookings, type AdminBooking } from "@/lib/admin/bookings";
import { formatDate, formatPrice, formatTime } from "@/lib/utils";
import type { BookingStatus } from "@/lib/types";
import { setBookingStatusAction } from "./actions";

export const metadata: Metadata = { title: "Bookings" };

export default async function AdminBookingsPage() {
  const { tenant } = await resolveAdminContext();
  const all = await getAdminBookings(tenant.id);

  const nowIso = new Date().toISOString();
  const upcoming = all.filter((b) => b.end >= nowIso);
  // Most-recent first for the history.
  const past = all.filter((b) => b.end < nowIso).reverse();

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage reservations for {tenant.name}.
        </p>
      </div>

      <BookingSection
        title="Upcoming"
        bookings={upcoming}
        currency={tenant.branding.currency}
        timezone={tenant.branding.timezone}
        emptyLabel="No upcoming bookings."
      />

      {past.length > 0 && (
        <BookingSection
          title="Past"
          bookings={past}
          currency={tenant.branding.currency}
          timezone={tenant.branding.timezone}
          emptyLabel="No past bookings."
        />
      )}
    </div>
  );
}

function BookingSection({
  title,
  bookings,
  currency,
  timezone,
  emptyLabel,
}: {
  title: string;
  bookings: AdminBooking[];
  currency: string;
  timezone: string;
  emptyLabel: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">
        {title}{" "}
        <span className="font-normal text-muted-foreground/70">
          ({bookings.length})
        </span>
      </h2>

      {bookings.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {bookings.map((b) => (
              <div
                key={b.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-4">
                  <div className="w-28 shrink-0 text-sm">
                    <div className="font-medium">
                      {formatDate(b.start, timezone)}
                    </div>
                    <div className="text-muted-foreground">
                      {formatTime(b.start, timezone)}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{b.guestName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.guestEmail}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {b.serviceName} · {formatPrice(b.priceCents, currency)}
                    </p>
                    {b.notes && (
                      <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
                        &ldquo;{b.notes}&rdquo;
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                  <BookingStatusBadge status={b.status} />
                  <StatusActions id={b.id} status={b.status} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/** Per-row status controls. Each button is a form posting to the server action. */
function StatusActions({ id, status }: { id: string; status: BookingStatus }) {
  const actions: { label: string; to: BookingStatus; variant: "outline" | "ghost" }[] =
    [];

  if (status === "pending") {
    actions.push({ label: "Confirm", to: "confirmed", variant: "outline" });
  }
  if (status === "confirmed") {
    actions.push({ label: "Mark done", to: "completed", variant: "outline" });
  }
  if (status === "pending" || status === "confirmed") {
    actions.push({ label: "Cancel", to: "cancelled", variant: "ghost" });
  }

  if (actions.length === 0) return null;

  return (
    <div className="flex gap-1.5">
      {actions.map((a) => (
        <form key={a.to} action={setBookingStatusAction.bind(null, id, a.to)}>
          <Button
            type="submit"
            size="sm"
            variant={a.variant}
            className={
              a.to === "cancelled"
                ? "text-destructive hover:text-destructive"
                : undefined
            }
          >
            {a.label}
          </Button>
        </form>
      ))}
    </div>
  );
}
