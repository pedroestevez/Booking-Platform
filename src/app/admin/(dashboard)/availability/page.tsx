import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveAdminContext } from "@/lib/admin/auth";
import { listAvailabilityRules, listBlockedSlots } from "@/lib/admin/config";
import { formatDate, formatTime } from "@/lib/utils";
import {
  createAvailabilityRuleAction,
  createBlockedSlotAction,
  deleteAvailabilityRuleAction,
  deleteBlockedSlotAction,
} from "./actions";

export const metadata: Metadata = { title: "Availability" };

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const selectClass =
  "flex h-11 w-full rounded-lg border border-input bg-background px-3.5 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:text-sm";

export default async function AdminAvailabilityPage() {
  const { tenant } = await resolveAdminContext();
  const [rules, blocked] = await Promise.all([
    listAvailabilityRules(tenant.id),
    listBlockedSlots(tenant.id),
  ]);
  const { timezone } = tenant.branding;

  const sortedRules = [...rules].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Availability</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Weekly open hours and one-off blocked dates. Times are in the tenant
          timezone ({timezone}).
        </p>
      </div>

      {/* ── Weekly hours ── */}
      <section className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add weekly hours</CardTitle>
            <CardDescription>
              One window per row — add several to cover split shifts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              action={createAvailabilityRuleAction}
              className="grid items-end gap-4 sm:grid-cols-2"
            >
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="dayOfWeek">Day</Label>
                <select id="dayOfWeek" name="dayOfWeek" className={selectClass} defaultValue="1">
                  {DAY_NAMES.map((name, i) => (
                    <option key={name} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="startTime">Opens</Label>
                <Input id="startTime" name="startTime" type="time" required defaultValue="09:00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="endTime">Closes</Label>
                <Input id="endTime" name="endTime" type="time" required defaultValue="17:00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bufferMinutes">Buffer (minutes)</Label>
                <Input
                  id="bufferMinutes"
                  name="bufferMinutes"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={0}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit">Add hours</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-2">
          {sortedRules.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No hours set — guests can&rsquo;t book until you add at least one
                window.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {sortedRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="text-sm">
                      <span className="font-medium">
                        {DAY_NAMES[rule.dayOfWeek]}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {rule.startTime}–{rule.endTime}
                        {rule.bufferMinutes > 0 &&
                          ` · ${rule.bufferMinutes} min buffer`}
                      </span>
                    </div>
                    <form action={deleteAvailabilityRuleAction.bind(null, rule.id)}>
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    </form>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      {/* ── Blocked dates ── */}
      <section className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Block off time</CardTitle>
            <CardDescription>
              Holidays, breaks, or any one-off window that overrides your hours.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              action={createBlockedSlotAction}
              className="grid items-end gap-4 sm:grid-cols-2"
            >
              <div className="space-y-1.5">
                <Label htmlFor="start">From</Label>
                <Input id="start" name="start" type="datetime-local" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="end">To</Label>
                <Input id="end" name="end" type="datetime-local" required />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="reason">Reason (optional)</Label>
                <Input id="reason" name="reason" placeholder="e.g. Public holiday" />
              </div>
              <div className="flex items-end">
                <Button type="submit">Add block</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-2">
          {blocked.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No blocked dates.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {blocked.map((slot) => (
                  <div
                    key={slot.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="min-w-0 text-sm">
                      <span className="font-medium">
                        {formatDate(slot.start, timezone)}{" "}
                        {formatTime(slot.start, timezone)}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        → {formatDate(slot.end, timezone)}{" "}
                        {formatTime(slot.end, timezone)}
                      </span>
                      {slot.reason && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {slot.reason}
                        </span>
                      )}
                    </div>
                    <form action={deleteBlockedSlotAction.bind(null, slot.id)}>
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                      >
                        Remove
                      </Button>
                    </form>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}
