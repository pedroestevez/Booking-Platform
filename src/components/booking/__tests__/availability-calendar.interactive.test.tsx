// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import type { AvailabilityRule, Service, TenantBranding } from "@/lib/types";

/**
 * The slot list, actually rendered (ALI-117 closure — reviewer item 1, security N3).
 *
 * ## Why this file exists
 *
 * Every other test of this component uses `renderToStaticMarkup`, which cannot
 * click. The slot list only renders once a day cell has been selected, so the
 * whole branch — the times the guest reads, and the instants behind them — was
 * never executed by any test. Two findings landed on that gap at once:
 *
 *   • **Reviewer 1.** `formatTime(slot.start, timeZone)` had no regression
 *     protection. Reverting it to browser-local rendering was free.
 *   • **Security N3.** The invariant-(e) tests re-derived `instantForCivilDate`
 *     themselves rather than reading the cell→instant binding out of the render,
 *     so applying the B1 defect *at the component's own call site* was measured
 *     at 0 red in all four zones. The tests recomputed the mechanism they were
 *     supposed to be checking.
 *
 * Both are the same shape: a test that rebuilds the thing under test cannot
 * fail when the thing under test breaks. So this file asserts **only** against
 * what the DOM says after a real click. It imports no helper from
 * `@/lib/availability` — deliberately, and that absence is the point. The
 * expected values below come from the *fixture rule* (`09:00–12:00`, a 60-minute
 * service), which is an independent statement of intent, not from re-running the
 * engine.
 *
 * ## Why the slot's accessible name carries the date
 *
 * `aria-label` on each slot button is `"Monday, September 7 at 9:00 AM"` — the
 * day and time in the **tenant's** zone. The visible text is the time alone. That
 * makes the binding observable in the product: the day the slot really falls on
 * is rendered right beside the day the guest clicked, so this test can compare
 * two strings that both came out of the render.
 */

const CUSTOMER_ID = "11111111-1111-1111-1111-111111111111";
const NEW_YORK = "America/New_York";

/** 09:00–12:00 every day. A 60-minute service steps 09:00 / 09:30 / … / 11:00. */
const NINE_TO_NOON: AvailabilityRule[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  id: `weekday-${dayOfWeek}`,
  customerId: CUSTOMER_ID,
  dayOfWeek,
  startTime: "09:00",
  endTime: "12:00",
  bufferMinutes: 0,
}));

/**
 * The times a guest must see, stated from the rule rather than computed from the
 * engine. The business said 09:00–12:00 on its own clock; a 60-minute service
 * fits five starts, the last ending exactly at noon.
 */
const EXPECTED_TENANT_TIMES = [
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
];

const SERVICE: Service = {
  id: "service-1",
  customerId: CUSTOMER_ID,
  name: "Interview",
  description: "",
  durationMinutes: 60,
  priceCents: 0,
  active: true,
};

const BRANDING: TenantBranding = {
  brandColor: "oklch(0.55 0.16 250)",
  currency: "USD",
  timezone: NEW_YORK,
};

afterEach(cleanup);

/**
 * Render, click a bookable day, and return what the DOM then says.
 *
 * The *last* enabled cell is chosen rather than the first: the first may be
 * today, whose earlier slots are filtered out as past, which would make the
 * expected list depend on the wall-clock moment the suite happens to run.
 */
function clickABookableDay() {
  render(
    <AvailabilityCalendar
      rules={NINE_TO_NOON}
      blocked={[]}
      bookings={[]}
      service={SERVICE}
      branding={BRANDING}
      onSelectSlot={() => undefined}
    />,
  );

  const bookable = screen
    .getAllByRole("button")
    .filter(
      (button) =>
        !button.hasAttribute("disabled") &&
        /^\w+day, \w+ \d+$/.test(button.getAttribute("aria-label") ?? ""),
    );
  expect(bookable.length).toBeGreaterThan(0);

  const cell = bookable[bookable.length - 1]!;
  const cellLabel = cell.getAttribute("aria-label")!;
  fireEvent.click(cell);

  const list = screen.getByRole("listbox", { name: "Available times" });
  const options = within(list).getAllByRole("option");

  return {
    cellLabel,
    visibleTimes: options.map((option) => option.textContent ?? ""),
    accessibleNames: options.map((option) => option.getAttribute("aria-label") ?? ""),
  };
}

describe("the slot list renders on the tenant's clock", () => {
  it("shows the business's own wall-clock times, not the browser's", () => {
    // Reviewer item 1. Under `TZ=UTC` a regression from
    // `formatTime(slot.start, timeZone)` to browser-local rendering turns
    // "9:00 AM" into "1:00 PM" — the same five slots, labelled four hours wrong,
    // directly beneath the caption naming the zone they are supposedly in.
    const { visibleTimes } = clickABookableDay();

    expect(visibleTimes).toEqual(EXPECTED_TENANT_TIMES);
  });

  it("names the tenant's zone beside the times it is rendering them in", () => {
    clickABookableDay();

    expect(screen.getByText("America/New York")).toBeDefined();
  });
});

describe("invariant check (e), read out of the render", () => {
  it("every slot the guest is offered falls on the day the guest clicked", () => {
    // Security N3. Both sides of this comparison are strings the component
    // produced: the cell's accessible name, and each slot's. Nothing here
    // recomputes `instantForCivilDate`, so passing a browser-local instant at the
    // component's call site — the B1 defect, one layer down — shows up as either
    // a date mismatch or an empty list.
    const { cellLabel, accessibleNames } = clickABookableDay();

    expect(accessibleNames.length).toBe(EXPECTED_TENANT_TIMES.length);
    for (const name of accessibleNames) {
      expect(name.startsWith(`${cellLabel} at `)).toBe(true);
    }
  });

  it("the accessible name pairs that day with the tenant-zone time", () => {
    const { cellLabel, accessibleNames } = clickABookableDay();

    expect(accessibleNames).toEqual(
      EXPECTED_TENANT_TIMES.map((time) => `${cellLabel} at ${time}`),
    );
  });
});
