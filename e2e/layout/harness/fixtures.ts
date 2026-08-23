import type { AvailabilityRule, Service, Tenant } from "@/lib/types";

/**
 * A tenant with wide-open weekday availability, used only to give the real
 * booking shell something to render. Nothing here is asserted on — the
 * assertions are about *layout*, so the data only has to be plausible and
 * deterministic.
 */
export const TENANT: Tenant = {
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "Layout Fixture Co.",
  slug: "layout-fixture",
  branding: {
    brandColor: "oklch(0.52 0.21 277)",
    tagline: "Book a time that works for you.",
    currency: "USD",
    // Fixed so the month grid is the same shape on every machine.
    timezone: "America/New_York",
  },
};

export const SERVICES: Service[] = [
  {
    id: "00000000-0000-0000-0000-0000000000b1",
    customerId: TENANT.id,
    name: "Intro call",
    description: "A short introductory conversation.",
    durationMinutes: 30,
    priceCents: 0,
    active: true,
  },
  {
    id: "00000000-0000-0000-0000-0000000000b2",
    customerId: TENANT.id,
    name: "Deep dive",
    description: "A longer working session.",
    durationMinutes: 60,
    priceCents: 12_000,
    active: true,
  },
];

/** Open 09:00–17:00 every day, so some cell in any month is always bookable. */
export const RULES: AvailabilityRule[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  id: `00000000-0000-0000-0000-0000000000c${dayOfWeek}`,
  customerId: TENANT.id,
  dayOfWeek,
  startTime: "09:00",
  endTime: "17:00",
  bufferMinutes: 0,
}));
