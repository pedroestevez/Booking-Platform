import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AvailabilityCalendar,
  formatCivilDate,
} from "@/components/booking/availability-calendar";
import {
  availableWeekdays,
  civilDateInTimeZone,
  civilMonthGrid,
  compareCivilDates,
  generateDaySlots,
  instantForCivilDate,
  weekdayOfCivilDate,
} from "@/lib/availability";
import type {
  AvailabilityRule,
  Service,
  TenantBranding,
  TimeSlot,
} from "@/lib/types";

/**
 * The guest grid speaks the tenant's calendar (ALI-117 B1).
 *
 * ## The defect these tests exist for
 *
 * The first version of this fix built each cell as a **browser-local midnight**
 * and then asked `weekdayInTimeZone` which tenant-zone weekday that instant fell
 * on. For any visitor east of the tenant that instant is the *previous* day, so
 * a Monday-only New York business rendered **Tuesday** cells enabled under
 * `TZ=UTC` — which is Vercel's SSR zone — and under `Europe/London`. Only under
 * `America/New_York` was it right.
 *
 * The engine was innocent: clicking the Tuesday cell produced a correct *Monday*
 * instant, and `createBooking` re-derived from `slot.start` and agreed. So the
 * guest read "Tuesday, August 18 — 1:00 PM", booked, and the confirmation email
 * and `.ics` put Monday 9:00 AM on two real calendars. Right instant, wrong day.
 *
 * ## Why the previous suite missed it
 *
 * It asserted only that two zones render *differently*. A wrong grid also
 * renders differently. The assertions below instead bind the **enabled cell** to
 * the **tenant-zone weekday**, and the **offered slots** to the **cell's own
 * calendar date** — claims a wrong grid cannot satisfy.
 *
 * ## Why this file runs under several process zones
 *
 * Every assertion here must hold in any process timezone, and `npm test` runs it
 * under `TZ=UTC` while `npm run test:tz` runs it again under
 * `Pacific/Kiritimati` (UTC+14), `Europe/London` (east of the tenant — the
 * defect's direction) and `America/New_York` (the one zone the broken version
 * got right, so it cannot be the only one checked).
 */

const CUSTOMER_ID = "11111111-1111-1111-1111-111111111111";
const NEW_YORK = "America/New_York";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function rulesForWeekday(dayOfWeek: number): AvailabilityRule[] {
  return [
    {
      id: `weekday-${dayOfWeek}`,
      customerId: CUSTOMER_ID,
      dayOfWeek,
      startTime: "09:00",
      endTime: "17:00",
      bufferMinutes: 0,
    },
  ];
}

const EVERY_DAY: AvailabilityRule[] = WEEKDAY_NAMES.flatMap((_, dayOfWeek) =>
  rulesForWeekday(dayOfWeek),
);

const SERVICE: Service = {
  id: "service-1",
  customerId: CUSTOMER_ID,
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

function render(timezone: string, rules: AvailabilityRule[]): string {
  return renderToStaticMarkup(
    <AvailabilityCalendar
      rules={rules}
      blocked={[]}
      bookings={[]}
      service={SERVICE}
      branding={branding(timezone)}
      onSelectSlot={() => undefined}
    />,
  );
}

interface Cell {
  label: string;
  enabled: boolean;
}

/** The day cells as rendered, read through their accessible labels. */
function dayCells(html: string): Cell[] {
  const buttons = html.match(/<button[^>]*aria-label="[^"]*"[^>]*>/g) ?? [];
  return buttons
    .map((button) => {
      const label = /aria-label="([^"]*)"/.exec(button)?.[1] ?? "";
      return { label, enabled: !button.includes("disabled") };
    })
    .filter((cell) => cell.label !== "Previous month" && cell.label !== "Next month");
}

function enabledLabels(timezone: string, rules: AvailabilityRule[]): string[] {
  return dayCells(render(timezone, rules))
    .filter((cell) => cell.enabled)
    .map((cell) => cell.label);
}

/** The cells the tenant's own calendar says are today or later, this month. */
function currentGrid(timeZone: string) {
  const today = civilDateInTimeZone(new Date(), timeZone);
  return {
    today,
    cells: civilMonthGrid(today),
  };
}

describe("the grid enables cells by the tenant's weekday, not the visitor's", () => {
  it("renders a month of day cells", () => {
    const cells = dayCells(render(NEW_YORK, EVERY_DAY));
    expect(cells.length).toBeGreaterThanOrEqual(28);
    expect(cells.some((cell) => cell.enabled)).toBe(true);
  });

  it.each(WEEKDAY_NAMES.map((name, index) => [name, index] as const))(
    "a tenant open only on %s enables only %s cells",
    (name, dayOfWeek) => {
      // The probe table, generalised. The Monday case is the reported defect:
      // before the fix this enabled Tuesday cells under TZ=UTC and Europe/London.
      for (const label of enabledLabels(NEW_YORK, rulesForWeekday(dayOfWeek))) {
        expect(label.startsWith(`${name},`)).toBe(true);
      }
    },
  );

  it("covers every bookable cell exactly once across the seven weekdays", () => {
    // The completeness half. Without it, a grid that disabled *everything* would
    // satisfy the per-weekday check above vacuously.
    const seen = new Set<string>();
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      for (const label of enabledLabels(NEW_YORK, rulesForWeekday(dayOfWeek))) {
        expect(seen.has(label)).toBe(false);
        seen.add(label);
      }
    }

    const { today, cells } = currentGrid(NEW_YORK);
    const expected = cells
      .filter((cell) => compareCivilDates(cell, today) >= 0)
      .map(formatCivilDate);

    expect([...seen].sort()).toEqual([...expected].sort());
    expect(expected.length).toBeGreaterThan(0);
  });

  it("labels each cell with the tenant's calendar date, identically in every process zone", () => {
    // The labels are formatted from civil dates, so a New York tenant's grid
    // reads the same in Auckland as it does in Miami. Under the old component
    // the labels came from `date-fns` `format` on a browser-local Date.
    const { cells } = currentGrid(NEW_YORK);
    const rendered = dayCells(render(NEW_YORK, EVERY_DAY)).map((cell) => cell.label);

    expect(rendered).toEqual(cells.map(formatCivilDate));
  });
});

describe("invariant check (e): the offered slots belong to the cell that was clicked", () => {
  /**
   * The check that (d) is structurally blind to.
   *
   * (d) asks whether the grid and the write path agree — and they did, on the
   * wrong day. Both consumers deriving the same wrong answer passes it. This
   * asks the question (d) cannot: does the instant the engine offers fall on the
   * calendar date the guest was *shown* when they clicked?
   */
  it("every slot under a cell falls on that cell's date in the tenant's zone", () => {
    const timeZone = NEW_YORK;
    const shown = new Set(enabledLabels(timeZone, EVERY_DAY));
    expect(shown.size).toBeGreaterThan(0);

    const { cells } = currentGrid(timeZone);
    let asserted = 0;

    for (const cell of cells) {
      const label = formatCivilDate(cell);
      if (!shown.has(label)) continue;

      const slots: TimeSlot[] = generateDaySlots({
        day: instantForCivilDate(cell, timeZone),
        rules: EVERY_DAY,
        service: SERVICE,
        timeZone,
      });

      for (const slot of slots) {
        // The guest clicked a cell labelled `label`. The instant they will be
        // booked at must be on that same calendar day, read on the tenant's
        // clock — the clock named beside the slot list.
        expect(formatCivilDate(civilDateInTimeZone(new Date(slot.start), timeZone))).toBe(
          label,
        );
        asserted += 1;
      }
    }

    expect(asserted).toBeGreaterThan(0);
  });

  it("holds on both DST transition days, where the day's length is not 24 hours", () => {
    const timeZone = NEW_YORK;
    const transitions: { label: string; date: { year: number; month: number; day: number } }[] = [
      { label: "spring forward", date: { year: 2026, month: 3, day: 8 } },
      { label: "fall back", date: { year: 2026, month: 11, day: 1 } },
    ];

    for (const { date } of transitions) {
      const slots = generateDaySlots({
        day: instantForCivilDate(date, timeZone),
        rules: EVERY_DAY,
        service: SERVICE,
        timeZone,
        now: new Date("2025-12-31T00:00:00.000Z"),
      });

      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(civilDateInTimeZone(new Date(slot.start), timeZone)).toEqual(date);
      }
    }
  });

  it("the grid's weekday and the engine's rule filter are the same answer", () => {
    // The remaining half of (d), kept: a cell is bookable exactly when the
    // engine has something to offer on it.
    const timeZone = NEW_YORK;
    const rules = rulesForWeekday(1);
    const open = availableWeekdays(rules);
    const { today, cells } = currentGrid(timeZone);

    for (const cell of cells) {
      if (compareCivilDates(cell, today) <= 0) continue; // "today" is `now`-filtered
      const gridSaysBookable = open.has(weekdayOfCivilDate(cell));
      const engineOffers =
        generateDaySlots({
          day: instantForCivilDate(cell, timeZone),
          rules,
          service: SERVICE,
          timeZone,
        }).length > 0;

      expect(gridSaysBookable).toBe(engineOffers);
    }
  });
});

describe("a misconfigured tenant gets an explicit state, not a blank page", () => {
  /**
   * Each case carries an `echoProbe`: a string that must **not** appear in the
   * rendered HTML if the component is refusing to echo the configured value back
   * at the guest.
   *
   * For a real zone the probe is the value itself. The empty string needs its
   * own, because `expect(html).not.toContain("")` is a tautology — every string
   * contains the empty string, so that assertion can never fail and the case
   * would silently assert nothing at all. `EMPTY_ZONE_PROBE` stands in for it: a
   * token that would only ever reach the DOM if the component started rendering
   * some placeholder for a missing zone.
   */
  const EMPTY_ZONE_PROBE = "__unset_timezone__";

  it.each([
    ["an empty timezone", "", EMPTY_ZONE_PROBE],
    ["a city that is not an IANA name", "Miami", "Miami"],
    ["a fixed offset", "+05:00", "+05:00"],
  ] as const)("renders a legible notice for %s", (_label, timezone, echoProbe) => {
    // `generateDaySlots` throws for these by design (criterion 2) and that is
    // right — but an unhandled throw in a client render has no boundary above it
    // here, so the tenant's whole booking page came back blank. Containment
    // only: refusing a bad zone at provisioning time is ALI-176/ALI-184's.
    let html = "";
    expect(() => {
      html = render(timezone, EVERY_DAY);
    }).not.toThrow();

    expect(html).toContain("Online booking is unavailable");
    expect(dayCells(html)).toHaveLength(0);
    // The raw configured value is not reflected back into the page.
    expect(html).not.toContain(echoProbe);
  });

  it("still renders normally for a valid zone (the control)", () => {
    const html = render(NEW_YORK, EVERY_DAY);
    expect(html).not.toContain("Online booking is unavailable");
    expect(dayCells(html).length).toBeGreaterThanOrEqual(28);
  });
});
