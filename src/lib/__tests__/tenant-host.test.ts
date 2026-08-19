import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getTenantByHost } from "@/lib/tenants";
import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * `getTenantByHost` (ALI-115) — the app-layer half of custom-domain
 * resolution.
 *
 * Mirrors the fake-driver pattern in `booking-tenant-scope.test.ts`, slimmed
 * to the one query shape this function issues:
 * `.from("customers").select().eq("custom_domain", host).maybeSingle()`.
 * Only the driver (`@/lib/supabase/server`) is faked — `getTenantByHost`
 * itself, `mapTenant`, and the real query-building code all run for real
 * against the fake.
 *
 * What this proves:
 *
 *   1. An exact `custom_domain` match resolves the right tenant.
 *   2. No match returns `null` — a lookup miss, not a thrown error.
 *   3. The match is case-sensitive: a differently-cased host does NOT match a
 *      lowercase-seeded row. That is deliberate — normalization (lowercasing,
 *      stripping a trailing `:port`) is documented as the CALLER's job
 *      (middleware, a later phase), not this function's. This test is what
 *      pins that division of responsibility: if `getTenantByHost` ever grew
 *      its own normalization, this case would start passing for the wrong
 *      reason and silently hide a caller that stopped normalizing.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

const TENANT = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Custom Domain Clinic",
  slug: "custom-domain-clinic",
  customDomain: "booking.example.com",
};

interface Row {
  [column: string]: unknown;
}

/** In-memory stand-in for `public.customers`, scoped to what this test needs. */
class FakeDatabase {
  readonly customers: Row[] = [
    {
      id: TENANT.id,
      name: TENANT.name,
      slug: TENANT.slug,
      branding_json: {},
      custom_domain: TENANT.customDomain,
    },
  ];
}

/**
 * A chainable PostgREST-shaped query builder, slimmed to the one shape
 * `getTenantByHost` uses: `select().eq(column, value).maybeSingle()`. `eq`
 * accumulates a real predicate; `maybeSingle` applies it — a query for a host
 * nothing matches comes back `{ data: null }`, exactly as it would from the
 * database.
 */
class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];

  constructor(
    private readonly db: FakeDatabase,
    private readonly tableName: "customers",
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.db.customers.filter((row) =>
      this.filters.every((f) => f(row)),
    );
    return { data: rows[0] ?? null, error: null };
  }
}

function fakeSupabase(db: FakeDatabase): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(db, table as "customers"),
  } as unknown as SupabaseClient;
}

let db: FakeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDatabase();
  vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase(db));
});

describe("getTenantByHost", () => {
  it("resolves the tenant on an exact custom_domain match", async () => {
    const tenant = await getTenantByHost(TENANT.customDomain);

    expect(tenant).not.toBeNull();
    expect(tenant?.id).toBe(TENANT.id);
    expect(tenant?.slug).toBe(TENANT.slug);
  });

  it("returns null, rather than throwing, on no match", async () => {
    await expect(
      getTenantByHost("booking.no-such-tenant.com"),
    ).resolves.toBeNull();
  });

  it("is case-sensitive: a differently-cased host does not match a lowercase-seeded row", async () => {
    // The seeded row is lowercase. Normalization is documented as the
    // caller's job — this function must not perform it implicitly.
    const upper = TENANT.customDomain.toUpperCase();
    expect(upper).not.toBe(TENANT.customDomain);

    await expect(getTenantByHost(upper)).resolves.toBeNull();
  });
});
