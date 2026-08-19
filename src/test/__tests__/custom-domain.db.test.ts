import { describe, expect, it } from "vitest";

import { hasTestDatabase, withRollback } from "@/test/supabase-harness";

/**
 * `customers.custom_domain` (migration 0008, ALI-211) against a real
 * Postgres: the two properties the column's rationale header calls a "hijack
 * primitive" without them — normalized form and uniqueness.
 *
 * `getTenantByHost` (`src/lib/tenants.ts`) resolves a request's Host header
 * straight into a `.eq("custom_domain", host).maybeSingle()` lookup — which
 * tenant's services, availability and upcoming bookings a visitor sees. If
 * two rows could share one value, or two differently-cased spellings of the
 * same host could both be stored, that lookup would resolve nondeterminately
 * or miss entirely. Neither failure is visible to a test that only checks
 * `getTenantByHost`'s own code against a fake — it has to be proved against
 * the constraint itself.
 *
 * A third property, added after review: `custom_domain` must never equal one
 * of the platform's own hosts (`booking.aligncompass.com`, `localhost`, any
 * `*.vercel.app`) — `isPlatformSharedHost` in `src/lib/request-host.ts` treats
 * those as never a tenant's domain and skips `getTenantByHost` for them
 * entirely, so a row that slipped past validation and claimed one would
 * become unreachable via both the slug route (permanently-redirects to `/`)
 * and the shared host (never resolves a tenant to redirect to). Availability,
 * not a leak — but silent, and this is the one place positioned to make it
 * impossible.
 *
 * ## Falsification (done by hand while building this, reverted after)
 *
 * Each "accepted" assertion below was run against migration 0008 with its
 * corresponding constraint individually commented out:
 *   - Without `customers_custom_domain_lowercase`: the uppercase-host insert
 *     that "rejects a non-lowercase custom_domain" expects to fail instead
 *     succeeded, turning that test red.
 *   - Without `customers_custom_domain_key`: the duplicate-value insert that
 *     "rejects two customers sharing one custom_domain" expects to fail
 *     instead succeeded, turning that test red.
 *   - Without `customers_custom_domain_not_platform_host`: the
 *     `booking.aligncompass.com` insert below succeeded instead of failing.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring.
 */

const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_UNIQUE_VIOLATION = "23505";

interface PgError {
  code?: string;
}

describe.skipIf(!hasTestDatabase)("customers.custom_domain (migration 0008)", () => {
  it("accepts a lowercase custom_domain", async () => {
    await withRollback(async (db) => {
      const rows = await db.query<{ custom_domain: string | null }>(
        `insert into public.customers (name, slug, custom_domain)
         values ($1, $2, $3)
         returning custom_domain`,
        ["Custom Domain Fixture", "custom-domain-fixture-1", "booking.pedroestevez.com"],
      );
      expect(rows[0]?.custom_domain).toBe("booking.pedroestevez.com");
    });
  });

  it("allows custom_domain to be left NULL (the common case)", async () => {
    await withRollback(async (db) => {
      const rows = await db.query<{ custom_domain: string | null }>(
        `insert into public.customers (name, slug)
         values ($1, $2)
         returning custom_domain`,
        ["Slug Only Fixture", "custom-domain-fixture-2"],
      );
      expect(rows[0]?.custom_domain).toBeNull();
    });
  });

  it("rejects a non-lowercase custom_domain", async () => {
    await withRollback(async (db) => {
      await expect(
        db.query(
          `insert into public.customers (name, slug, custom_domain)
           values ($1, $2, $3)`,
          ["Uppercase Fixture", "custom-domain-fixture-3", "Booking.PedroEstevez.com"],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE_CHECK_VIOLATION } satisfies PgError);
    });
  });

  it("rejects two customers sharing one custom_domain", async () => {
    await withRollback(async (db) => {
      await db.query(
        `insert into public.customers (name, slug, custom_domain)
         values ($1, $2, $3)`,
        ["First Claimant", "custom-domain-fixture-4a", "booking.shared-host.example"],
      );

      await expect(
        db.query(
          `insert into public.customers (name, slug, custom_domain)
           values ($1, $2, $3)`,
          ["Second Claimant", "custom-domain-fixture-4b", "booking.shared-host.example"],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE_UNIQUE_VIOLATION } satisfies PgError);
    });
  });

  it("rejects the platform's own shared host as a custom_domain", async () => {
    await withRollback(async (db) => {
      await expect(
        db.query(
          `insert into public.customers (name, slug, custom_domain)
           values ($1, $2, $3)`,
          ["Hijack Attempt", "custom-domain-fixture-6", "booking.aligncompass.com"],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE_CHECK_VIOLATION } satisfies PgError);
    });
  });

  it("rejects a *.vercel.app host as a custom_domain", async () => {
    await withRollback(async (db) => {
      await expect(
        db.query(
          `insert into public.customers (name, slug, custom_domain)
           values ($1, $2, $3)`,
          ["Hijack Attempt 2", "custom-domain-fixture-7", "some-preview.vercel.app"],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE_CHECK_VIOLATION } satisfies PgError);
    });
  });

  it("rejects localhost as a custom_domain", async () => {
    await withRollback(async (db) => {
      await expect(
        db.query(
          `insert into public.customers (name, slug, custom_domain)
           values ($1, $2, $3)`,
          ["Hijack Attempt 3", "custom-domain-fixture-8", "localhost"],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE_CHECK_VIOLATION } satisfies PgError);
    });
  });

  it("allows any number of customers to share NULL custom_domain (partial index)", async () => {
    await withRollback(async (db) => {
      await db.query(
        `insert into public.customers (name, slug) values ($1, $2)`,
        ["No Domain A", "custom-domain-fixture-5a"],
      );
      const rows = await db.query(
        `insert into public.customers (name, slug) values ($1, $2) returning id`,
        ["No Domain B", "custom-domain-fixture-5b"],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
