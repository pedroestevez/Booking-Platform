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
 *
 * NOTE ON `server-only` (ALI-98): that package's `exports` map resolves to a
 * module which throws by design outside a `react-server` condition, so any
 * test importing a server module (`src/lib/bookings.ts`, `src/lib/supabase/*`)
 * would fail at import time under `environment: "node"`. Aliasing it to the
 * package's own `empty.js` — the file it ships for exactly this purpose —
 * makes server modules testable. `next build` never reads this config, so the
 * production guard is unaffected. One alias here beats a `vi.mock` in every
 * future server-module test file.
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
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
