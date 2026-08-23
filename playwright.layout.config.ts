import { defineConfig, devices } from "@playwright/test";

/**
 * Layout regression tests (ALI-221) — a separate config from
 * `playwright.config.ts` on purpose.
 *
 * The main e2e config drives the *running application*: it starts a server (or
 * targets a preview) and its suite skips without `E2E_TENANT_SLUG`, because the
 * app reads tenants from Supabase over PostgREST and a hermetic Postgres
 * container cannot serve it. That skip is honest, but a layout regression
 * caught only when a preview project happens to be configured is a regression
 * that ships. This config runs on every pull request instead: no server, no
 * database, no secrets — just the real component tree and the real stylesheet
 * in a real browser.
 */
export default defineConfig({
  testDir: "./e2e/layout",
  globalSetup: "./e2e/layout/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  // Deliberately no `webServer`: the harness is a file:// page.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
