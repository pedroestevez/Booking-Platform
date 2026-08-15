import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CalendarDays, DollarSign, Scissors } from "lucide-react";

import { KpiCard } from "@/components/admin/kpi-card";
import { BookingStatusBadge } from "@/components/admin/booking-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveAdminContext } from "@/lib/admin/auth";
import { getAdminOverview } from "@/lib/admin/bookings";
import { formatDate, formatPrice, formatTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

export default async function AdminOverviewPage() {
  const { tenant } = await resolveAdminContext();
  const overview = await getAdminOverview(tenant.id);
  const { currency, timezone } = tenant.branding;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A snapshot of {tenant.name}&rsquo;s bookings.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Upcoming bookings"
          value={overview.upcomingCount}
          icon={CalendarClock}
        />
        <KpiCard
          label="Today"
          value={overview.todayCount}
          hint="Starting today"
          icon={CalendarDays}
        />
        <KpiCard
          label="Active services"
          value={overview.activeServices}
          icon={Scissors}
        />
        <KpiCard
          label="Revenue booked"
          value={formatPrice(overview.revenueBookedCents, currency)}
          hint="Upcoming, pending + confirmed"
          icon={DollarSign}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Next bookings</CardTitle>
          <Link
            href="/admin/bookings"
            className="text-sm font-medium text-primary hover:underline"
          >
            View all
          </Link>
        </CardHeader>
        <CardContent>
          {overview.nextBookings.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No upcoming bookings yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {overview.nextBookings.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {b.guestName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.serviceName}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    <div className="text-xs text-muted-foreground">
                      <div>{formatDate(b.start, timezone)}</div>
                      <div>{formatTime(b.start, timezone)}</div>
                    </div>
                    <BookingStatusBadge status={b.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
