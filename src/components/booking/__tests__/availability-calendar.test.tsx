import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import type { AvailabilityRule, Service, TenantBranding } from "@/lib/types";

/**
 * The guest grid dims days by the **tenant's** weekday, not the browser's
 * (ALI-117 criterion 7, first half).
 *
 * ## Why this renders the component
 *
 * The criterion is about what a visitor sees. `isDayBookable` used
 * `day.getDay()`, which answers for whatever zone the *browser* happens to be
 * in — so a visitor in Auckland looking at a Miami business could be offered
 * Tuesday for a Monday-only calendar, and then be shown Monday's times on it.
 * Asserting `weekdayInTimeZone` in isolation proves the helper and nothing about
 * the grid: the old component would still pass such a test while dimming the
 * wrong column, because it never called the helper at all.
 *
 * ## Why these two zones, and why no fixed dates
 *
 * `Pacific/Kiritimati` is UTC+14 and `Pacific/Niue` is UTC−11 — 25 hours apart,
 * neither observing DST. Because that gap exceeds 24 hours, the two zones can
 * **never** agree on the calendar date, and therefore never on the weekday, for
 * any instant whatsoever. So "these two renders must differ" holds no matter
 * what today's date is and no matter which timezone the test process runs in —
 * which matters, because this suite runs under `TZ=UTC` and the availability
 * suite runs again under `TZ=Pacific/Kiritimati`.
 *
 * A component reading `day.getDay()` produces byte-identical markup for both,
 * since the tenant's zone never enters the decision. That is the failure this
 * asserts against, and it is why the same-zone control below is here: without
 * it, "the renders differ" could be satisfied by any nondeterminism at all.
 */

const RULES: AvailabilityRule[] = [
  {
    id: "monday-only",
    customerId: "11111111-1111-1111-1111-111111111111",
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "12:00",
    bufferMinutes: 0,
  },
];

const SERVICE: Service = {
  id: "service-1",
  customerId: "11111111-1111-1111-1111-111111111111",
  name: "Interview",
  description: "",
  durationMinutes: 60,
  priceCents: 0,
  active: true,
};

function branding(timezone: string): TenantBranding {
  return {
    brandColor: "oklch(0.55 0.16 250)",
    currency: "USD",
    timezone,
  };
}

function render(timezone: string): string {
  return renderToStaticMarkup(
    <AvailabilityCalendar
      rules={RULES}
      blocked={[]}
      bookings={[]}
      service={SERVICE}
      branding={branding(timezone)}
      onSelectSlot={() => undefined}
    />,
  );
}

/**
 * Which day cells came out bookable, as a positional on/off string.
 *
 * Positional rather than by date: the labels are formatted in the *process*
 * zone, so their text is not stable across the two runs this suite makes, but
 * the pattern of enabled cells within the month grid is exactly what a visitor
 * sees.
 */
function bookablePattern(html: string): string {
  const cells = html.match(/<button[^>]*aria-label="[^"]*"[^>]*>/g) ?? [];
  return cells.map((cell) => (cell.includes("disabled") ? "." : "#")).join("");
}

describe("AvailabilityCalendar dims days in the tenant's timezone", () => {
  it("renders a month grid with day cells", () => {
    // Guards every assertion below: a component that rendered nothing would
    // otherwise satisfy "the two patterns differ" vacuously with two empty
    // strings — except that they would be equal, so this also guards that.
    const pattern = bookablePattern(render("Pacific/Kiritimati"));
    expect(pattern.length).toBeGreaterThanOrEqual(28);
    expect(pattern).toMatch(/#/);
  });

  it("dims a different set of days for two zones that can never share a date", () => {
    const kiritimati = bookablePattern(render("Pacific/Kiritimati")); // UTC+14
    const niue = bookablePattern(render("Pacific/Niue")); // UTC−11

    expect(kiritimati).not.toBe(niue);
  });

  it("is deterministic for a single zone (the control)", () => {
    expect(bookablePattern(render("Pacific/Niue"))).toBe(
      bookablePattern(render("Pacific/Niue")),
    );
    expect(bookablePattern(render("America/New_York"))).toBe(
      bookablePattern(render("America/New_York")),
    );
  });

});

/**
 * A note on what is deliberately *not* asserted here.
 *
 * An ordinary pair like `UTC` vs `America/New_York` is **not** used, because the
 * grid's day cells are built from process-local midnights: whether two such
 * zones disagree about a given cell's weekday depends on the zone the test
 * process runs in, so an assertion on them passes under `TZ=UTC` and fails under
 * `TZ=Pacific/Kiritimati` — measured, not assumed. A test whose result depends
 * on the process timezone is the exact defect this issue removes, so the only
 * pair used is one for which the answer is forced.
 */
