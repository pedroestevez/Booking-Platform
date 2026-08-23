import { expect, test, type Page } from "@playwright/test";

import { HARNESS_HTML } from "./harness/build";

/**
 * ALI-221 — the booking calendar's day cells must not collapse.
 *
 * ## Why this suite exists and why it is not a component test
 *
 * The regression this guards against measured **4.28px** per day cell on
 * `booking.pedroestevez.com` at 1728×906, with the date numbers printing on top
 * of one another. Nothing was wrong with the month grid itself. Two nested
 * fixed-column grids — the flow shell's `20rem` summary rail and the calendar's
 * own `18rem` slot list — both billed the same `max-w-3xl` (768px) container,
 * and the calendar's `minmax(0,1fr)` column, having a floor of zero, absorbed
 * the shortfall by shrinking to 54px. `grid-cols-7` then split that seven ways.
 *
 * That makes it a *computed layout* failure of an ancestor chain, and it is
 * why it shipped: **a test that mounts `AvailabilityCalendar` on its own passes
 * while the bug is live**, because in isolation nothing is competing for its
 * width. So does anything running in jsdom, which has no layout engine at all
 * — every width there is 0.
 *
 * This suite therefore renders the real `TenantBookingPage` tree, with the real
 * compiled Tailwind stylesheet, in a real browser, at real desktop widths, and
 * measures. See `harness/build.ts` for how it stays hermetic without
 * weakening any of that.
 */

/** AC1's threshold. The regression was 4.28px; a legible cell needs ~14–18px of glyph. */
const MIN_CELL_WIDTH_PX = 32;

interface Box {
  left: number;
  right: number;
  width: number;
  height: number;
  text: string;
}

test.describe("booking page shell — calendar geometry", () => {
  /**
   * AC1/AC2/AC3 at the three widths the issue names. Each is above the `lg`
   * breakpoint, so the summary rail is active — which is the only regime in
   * which the collapse happens at all.
   */
  for (const width of [1280, 1440, 1728]) {
    test(`day cells stay legible at ${width}px`, async ({ page }) => {
      await openScheduleStep(page, { width, height: 900 });

      // Guard the premise. If the shell ever stops rendering its fixed rail
      // beside the flow, this suite would keep passing while measuring a page
      // that can no longer reproduce the bug — a green that means nothing.
      await expectSummaryRailBesideFlow(page);

      const cells = await dayCellBoxes(page);
      // 5 or 6 week rows depending on where the month starts.
      expect(cells.length % 7, "the month grid is not a whole number of weeks").toBe(0);
      expect(cells.length).toBeGreaterThanOrEqual(35);

      // ── AC1: legible, non-collapsed cells ──────────────────────────────
      const narrowest = Math.min(...cells.map((c) => c.width));
      expect(
        narrowest,
        `narrowest day cell was ${narrowest.toFixed(2)}px (regression measured 4.28px)`,
      ).toBeGreaterThanOrEqual(MIN_CELL_WIDTH_PX);

      // `aspect-square` was being overridden by the text in the regression —
      // 4px wide against 20px tall. A cell that is still square is a cell that
      // was never squeezed.
      for (const cell of cells) {
        expect(Math.abs(cell.width - cell.height)).toBeLessThanOrEqual(1);
      }

      // ── AC2: no horizontal overlap between adjacent cells ──────────────
      for (let row = 0; row < cells.length / 7; row += 1) {
        for (let col = 1; col < 7; col += 1) {
          const prev = cells[row * 7 + col - 1];
          const next = cells[row * 7 + col];
          if (!prev || !next) throw new Error("missing cell");
          expect(
            next.left,
            `week ${row + 1}: "${next.text}" starts before "${prev.text}" ends`,
          ).toBeGreaterThanOrEqual(prev.right - 0.5);
        }
      }

      // ── AC3: weekday header letters sit over their columns ─────────────
      const headers = await weekdayHeaderBoxes(page);
      expect(headers.map((h) => h.text)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
      for (let col = 0; col < 7; col += 1) {
        const header = headers[col];
        const cell = cells[col];
        if (!header || !cell) throw new Error("missing header/cell");
        expect(header.width).toBeGreaterThanOrEqual(MIN_CELL_WIDTH_PX);
        expect(
          Math.abs(centre(header) - centre(cell)),
          `weekday "${header.text}" is not centred over its column`,
        ).toBeLessThanOrEqual(1);
      }

      // The month nav sat in a 54px column in the regression and spilled out
      // of it — the stray `>` printed over the slot list's date heading. If the
      // column is wide enough to hold the nav, it cannot escape into its
      // neighbour.
      const nav = await monthNavBox(page);
      const grid = await monthGridBox(page);
      expect(nav.right, "the month nav overflows the calendar column").toBeLessThanOrEqual(
        grid.right + 0.5,
      );
    });
  }

  /**
   * AC4. These widths never reproduced the bug — below `lg` the shell is a
   * single column — so this is a regression guard on the fix, not on the bug.
   */
  for (const width of [375, 768]) {
    test(`narrow layout stays usable at ${width}px`, async ({ page }) => {
      await openScheduleStep(page, { width, height: 900 });

      const cells = await dayCellBoxes(page);
      expect(cells.length % 7).toBe(0);
      expect(cells.length).toBeGreaterThanOrEqual(35);

      const narrowest = Math.min(...cells.map((c) => c.width));
      expect(narrowest).toBeGreaterThanOrEqual(MIN_CELL_WIDTH_PX);

      for (let row = 0; row < cells.length / 7; row += 1) {
        for (let col = 1; col < 7; col += 1) {
          const prev = cells[row * 7 + col - 1];
          const next = cells[row * 7 + col];
          if (!prev || !next) throw new Error("missing cell");
          expect(next.left).toBeGreaterThanOrEqual(prev.right - 0.5);
        }
      }

      // Nothing may push the page sideways at a phone width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);
    });
  }
});

function centre(box: Box): number {
  return box.left + box.width / 2;
}

/** Loads the harness and advances the real flow to step 2 by clicking a service. */
async function openScheduleStep(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`file://${HARNESS_HTML}`);

  // Before the click, the only `aria-pressed` buttons are the service cards;
  // after it, they are the day cells. Same discriminator the e2e suite uses.
  const services = page.locator("button[aria-pressed]");
  await expect(services.first()).toBeVisible();
  await services.first().click();

  await expect(page.getByText("Pick a time")).toBeVisible();
}

/**
 * Fails unless the flow shell is actually rendering its fixed summary rail to
 * the right of the flow — i.e. unless the page is in the regime that produced
 * the 4.28px cells.
 */
async function expectSummaryRailBesideFlow(page: Page): Promise<void> {
  const rail = page.locator("aside").filter({ hasText: "Summary" });
  await expect(rail, "the summary rail is not rendered").toBeVisible();

  const railBox = await rail.boundingBox();
  const gridBox = await monthGridBox(page);
  if (!railBox) throw new Error("summary rail has no box");
  expect(
    railBox.x,
    "the summary rail is not beside the calendar — this page cannot reproduce ALI-221",
  ).toBeGreaterThan(gridBox.right - 1);
}

/** Every day-cell button, in DOM order (5 weeks × 7 columns). */
async function dayCellBoxes(page: Page): Promise<Box[]> {
  return page.locator("button[aria-pressed]").evaluateAll(measure);
}

/** The seven `S M T W T F S` labels, which are the month grid's first children. */
async function weekdayHeaderBoxes(page: Page): Promise<Box[]> {
  return page
    .locator("button[aria-pressed]")
    .first()
    .evaluate((first) => {
      const grid = first.parentElement;
      if (!grid) throw new Error("day cell has no grid parent");
      return [...grid.children].slice(0, 7).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          text: (el.textContent ?? "").trim(),
        };
      });
    });
}

/** The `grid-cols-7` month grid itself — the box the day cells are packed into. */
async function monthGridBox(page: Page): Promise<Box> {
  return page
    .locator("button[aria-pressed]")
    .first()
    .evaluate((first) => {
      const grid = first.parentElement;
      if (!grid) throw new Error("day cell has no grid parent");
      const r = grid.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height, text: "" };
    });
}

/** The previous/next month controls. */
async function monthNavBox(page: Page): Promise<Box> {
  const next = page.getByRole("button", { name: "Next month" });
  const box = await next.boundingBox();
  if (!box) throw new Error("next-month control has no box");
  return {
    left: box.x,
    right: box.x + box.width,
    width: box.width,
    height: box.height,
    text: "next month",
  };
}

function measure(elements: Element[]): Box[] {
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
      text: (el.textContent ?? "").trim(),
    };
  });
}
