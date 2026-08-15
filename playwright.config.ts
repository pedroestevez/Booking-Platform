import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests. Separate from Vitest: `npm test` runs unit/integration
 * tests with no browser and no network; `npm run test:e2e` drives a real
 * browser against a running app.
 *
 * Chromium is preinstalled in CI and in the dev container
 * (`PLAYWRIGHT_BROWSERS_PATH`), so no `playwright install` step is needed.
 *
 * Point `E2E_BASE_URL` at a deployed preview to test it directly; when it is
 * absent (or local) the config builds and starts the app itself.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const isLocal = /(?:127\.0\.0\.1|localhost)/.test(BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Never let a stray `.only` silently shrink the suite in CI.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(isLocal
    ? {
        webServer: {
          command: "npm run build && npm run start",
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }
    : {}),
});
