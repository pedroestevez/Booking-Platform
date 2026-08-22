import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createServiceRoleClient,
  createTenantScopedClient,
} from "@/lib/supabase/server";

/**
 * The token `createTenantScopedClient` mints is the entire tenant boundary
 * (ALI-116). Everything downstream — all 28 policies across seven tables —
 * hangs off three fields inside it, and every one of them fails *silently* if
 * it is wrong:
 *
 *   • a misspelt `customer_id` claim → `app.current_customer_id()` returns
 *     NULL → every page renders empty, and no test that mocks the client would
 *     notice;
 *   • `role: "service_role"` → PostgREST switches to a role carrying BYPASSRLS
 *     on hosted Supabase → **every tenant sees every other tenant's rows**,
 *     with the app-code filters as the only thing left;
 *   • a signature the project cannot verify → 401 on every request.
 *
 * None of those is visible from the app's own behaviour under a mocked client,
 * so they are asserted here against the bytes actually put on the wire.
 *
 * The env vars are stubbed rather than mocked out: the point is to exercise the
 * real minting path.
 */

const SUPABASE_URL = "https://project.supabase.co";
const ANON = "anon-key";
const SECRET = "test-jwt-secret-not-a-real-one";
const TENANT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_JWT_SECRET = SECRET;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The bearer token the client will actually send, read off its own headers. */
function bearerOf(customerId: string): string {
  const client = createTenantScopedClient(customerId) as unknown as {
    headers: Record<string, string>;
  };
  const header = client.headers.Authorization ?? "";
  expect(header, "no Authorization header on the tenant-scoped client").toMatch(
    /^Bearer /,
  );
  return header.slice("Bearer ".length);
}

function decodeClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

describe("createTenantScopedClient", () => {
  it("signs the customer_id claim migration 0009 reads", () => {
    const claims = decodeClaims(bearerOf(TENANT));
    expect(claims.customer_id).toBe(TENANT);
  });

  it("claims the authenticated role, never service_role", () => {
    const claims = decodeClaims(bearerOf(TENANT));
    // The single most consequential field here: `service_role` carries
    // BYPASSRLS on hosted Supabase, so a token claiming it would disable every
    // policy while looking, from the app's side, exactly like this one.
    expect(claims.role).toBe("authenticated");
    expect(claims.role).not.toBe("service_role");
    expect(claims.role).not.toBe("anon");
  });

  it("signs HS256 with SUPABASE_JWT_SECRET, so PostgREST can verify it", () => {
    const token = bearerOf(TENANT);
    const [header, payload, signature] = token.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(signature).toBe(
      createHmac("sha256", SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url"),
    );
  });

  it("expires the token, and soon", () => {
    const claims = decodeClaims(bearerOf(TENANT)) as unknown as {
      iat: number;
      exp: number;
    };
    expect(claims.exp).toBeGreaterThan(claims.iat);
    // A token that outlives its request is a credential lying around in a log.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
  });

  it("gives two tenants two different tokens — no client is reused across tenants", () => {
    // The regression test for the failure ALI-138 rejected the session-GUC
    // design over: tenant state that survives one request and is inherited by
    // the next. Caching the client by anything other than the tenant id would
    // reintroduce it here.
    const a = decodeClaims(bearerOf(TENANT));
    const b = decodeClaims(bearerOf(OTHER_TENANT));
    expect(a.customer_id).toBe(TENANT);
    expect(b.customer_id).toBe(OTHER_TENANT);
  });

  it("throws rather than falling back to service-role when the secret is missing", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    // Falling back would leave RLS inert while every test stayed green — the
    // exact defect ALI-116 exists to close.
    expect(() => createTenantScopedClient(TENANT)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("throws on anything that is not a server-resolved UUID", () => {
    for (const bad of ["", "not-a-uuid", "' or 1=1 --", `${TENANT} `]) {
      expect(() => createTenantScopedClient(bad)).toThrow(
        /server-resolved customer UUID/,
      );
    }
  });

  it("still builds the service-role client for the allow-listed lookups", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    expect(() => createServiceRoleClient()).not.toThrow();
  });
});
