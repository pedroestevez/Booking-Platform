import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit + integration tests (Vitest). End-to-end tests run under Playwright
 * (`playwright.config.ts`) and are excluded here so `npm test` stays fast.
 *
 * NOTE ON TIMEZONE: the npm script pins `TZ=UTC`. `generateDaySlots` currently
 * resolves rule times against the *runtime* timezone (see the NOTE in
 * `src/lib/availability.ts`), so without pinning, results would differ by
 * machine. The pin makes the suite deterministic; it does not fix the
 * underlying tenant-timezone gap, which is tracked separately.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
