import { expect, test, type Page } from "@playwright/test";

/**
 * Walks the guest booking flow end to end: service → time → details → pending
 * booking. This is the path a real client takes, so it is the one path that
 * must never silently break.
 *
 * Requires a tenant with at least one active service and open availability.
 * Set `E2E_TENANT_SLUG` to that tenant's slug; the suite skips without it,
 * because a false green is worse than an honest skip.
 *
 * NOTE: this writes a real `pending` booking to whatever database the target
 * app is pointed at. Run it against a preview/branch environment, not
 * production.
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG;

test.describe("guest booking flow", () => {
  test.skip(!TENANT_SLUG, "Set E2E_TENANT_SLUG to a tenant with open availability.");

  test("books a slot and reaches confirmation", async ({ page }) => {
    await page.goto(`/${TENANT_SLUG}`);

    // ── Step 1: service ──────────────────────────────────────────────────
    await expect(page.getByText("Choose a service")).toBeVisible();

    const services = page.locator("button[aria-pressed]");
    await expect(services.first()).toBeVisible();
    await services.first().click();

    // ── Step 2: schedule ─────────────────────────────────────────────────
    await expect(page.getByText("Pick a time")).toBeVisible();

    const slot = await selectFirstAvailableSlot(page);
    expect(
      slot,
      "No bookable slot found in the visible month — check the tenant's availability rules.",
    ).toBe(true);

    await page.getByRole("button", { name: "Continue" }).click();

    // ── Step 3: details ──────────────────────────────────────────────────
    await expect(page.getByText("Your details")).toBeVisible();

    // Unique address per run so the resolve-or-create identity path is
    // exercised without colliding with earlier runs.
    const email = `e2e+${Date.now()}@example.com`;
    await page.locator("#guest-name").fill("E2E Test Guest");
    await page.locator("#guest-email").fill(email);

    await page.getByRole("button", { name: "Confirm booking" }).click();

    // ── Step 4: confirmation ─────────────────────────────────────────────
    // If the server action failed it renders role="alert" instead — surface
    // that message rather than a bare timeout.
    const alert = page.getByRole("alert");
    const confirmation = page.getByText("Confirmation");

    await expect
      .poll(
        async () =>
          (await confirmation.isVisible())
            ? "confirmed"
            : (await alert.isVisible())
              ? `error: ${await alert.textContent()}`
              : "pending",
        { timeout: 20_000 },
      )
      .toBe("confirmed");
  });
});

/**
 * Click through days in the visible month until one exposes bookable times,
 * then select the first. Returns false if the whole month is empty.
 */
async function selectFirstAvailableSlot(page: Page): Promise<boolean> {
  const days = page.locator("button[aria-pressed]:not([disabled])");
  const dayCount = await days.count();

  for (let i = 0; i < dayCount; i++) {
    await days.nth(i).click();

    const times = page.getByRole("listbox", { name: "Available times" });
    if (!(await times.isVisible().catch(() => false))) continue;

    const options = times.getByRole("option");
    if ((await options.count()) > 0) {
      await options.first().click();
      return true;
    }
  }

  return false;
}
