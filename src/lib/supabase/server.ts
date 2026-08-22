import "server-only";

import { createHmac } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase access.
 *
 * Two clients, and the difference is the whole tenant-isolation model:
 *
 *   • `createTenantScopedClient(customerId)` — **the default.** Carries a
 *     server-minted JWT whose `customer_id` claim the RLS policies read, so
 *     the database itself refuses to return another tenant's rows.
 *   • `createServiceRoleClient()` — bypasses RLS. Permitted only for the
 *     bootstrap lookups enumerated below.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ SERVICE-ROLE ALLOW-LIST (ALI-116 criterion 3)                            ║
 * ║                                                                          ║
 * ║ These are the only permitted callers of `createServiceRoleClient()`.     ║
 * ║ Each one *produces* a tenant id and therefore cannot be scoped by one —  ║
 * ║ there is no `customer_id` yet to satisfy a policy with.                  ║
 * ║                                                                          ║
 * ║  1. `getTenantBySlug`   — src/lib/tenants.ts. slug → customers.id. The   ║
 * ║                           public booking path's entry point.             ║
 * ║  2. `getTenantByHost`   — src/lib/tenants.ts. custom domain →           ║
 * ║                           customers.id. Same lookup, addressed by host.  ║
 * ║  3. `getMembershipBySubject` — src/lib/admin/auth.ts. Clerk             ║
 * ║                           auth_subject → tenant_members.customer_id.    ║
 * ║                           The admin path's entry point.                  ║
 * ║  4. `getAllTenants`     — src/lib/tenants.ts. Enumerates every tenant   ║
 * ║                           for the dev index at `/`. Genuinely            ║
 * ║                           cross-tenant, so no single claim can scope it. ║
 * ║                           FLAGGED, not endorsed: it is the one entry     ║
 * ║                           here that is a convenience rather than a       ║
 * ║                           bootstrap, and it should be deleted or gated   ║
 * ║                           rather than allow-listed. Raised on ALI-116.   ║
 * ║                                                                          ║
 * ║ Anything else reaching for the service-role client is a finding to       ║
 * ║ escalate, not a judgement call to make inline.                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The service-role key must NEVER reach a Client Component.
 */

let cachedServiceRole: SupabaseClient | null = null;

/**
 * RLS-bypassing client. See the allow-list above before adding a caller.
 */
export function createServiceRoleClient(): SupabaseClient {
  if (cachedServiceRole) return cachedServiceRole;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in the environment (see .env.example).",
    );
  }

  cachedServiceRole = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedServiceRole;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long a minted tenant token is valid. Long enough to outlive any single
 * request (including a slow Stripe round trip), short enough that a token that
 * escapes in a log line is worthless by the time anyone reads it. Nothing
 * stores or reuses these — one is minted per client.
 */
const TOKEN_TTL_SECONDS = 120;

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Mint the per-request tenant token.
 *
 * HS256 signed with `SUPABASE_JWT_SECRET`, which is what PostgREST verifies
 * with. `role: "authenticated"` is what makes PostgREST `set role` to a role
 * the policies actually apply to — `service_role` carries BYPASSRLS on hosted
 * Supabase, so a token claiming it would defeat the entire mechanism.
 *
 * Deliberately hand-rolled over `node:crypto` rather than adding a JWT
 * dependency: this mints exactly one token shape, and HS256 is an HMAC over two
 * base64url segments. There is no parsing or verification side here — the
 * database does that — so the usual reason to reach for a library does not
 * apply.
 */
function mintTenantToken(customerId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    // The claim migration 0009's `app.current_customer_id()` reads, and with it
    // all 28 policies from 0002/0003/0004.
    customer_id: customerId,
  });
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/**
 * A Supabase client that the database will only let read and write one
 * tenant's rows (ALI-116, implementing the ALI-138 mechanism decision).
 *
 * ## Where `customerId` must come from
 *
 * The **server's** own resolution — `getTenantBySlug` / `getTenantByHost` for
 * the guest path, `getMembershipBySubject` for admin — and never a request
 * payload. This is the same trust surface ALI-139 closed: a caller who can
 * choose the id can choose the tenant, and here that choice is signed into a
 * token the database then trusts completely. Passing a browser-supplied value
 * in would not merely bypass RLS, it would *weaponize* it.
 *
 * ## Why a fresh client per call
 *
 * Each client carries one tenant's token in a header fixed at construction, so
 * a cached client is a cached tenant. That is precisely the failure ALI-138
 * rejected the session-scoped-GUC design for: state that outlives the request
 * and gets inherited by the next one. A `SupabaseClient` opens no connection —
 * it is a fetch wrapper — so constructing one per call costs an object, and the
 * alternative costs a cross-tenant leak. Tokens also expire, which a cache
 * would have to track.
 *
 * ## Why it throws rather than falling back
 *
 * With `SUPABASE_JWT_SECRET` unset, the tempting move is to fall back to the
 * service-role client "so the app still works". That leaves RLS inert while
 * every test stays green — the exact defect this issue exists to close, and the
 * failure mode ALI-116 criterion 4 guards. A missing secret is a deployment
 * error and reads as one.
 */
export function createTenantScopedClient(customerId: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment (see .env.example).",
    );
  }
  if (!jwtSecret) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set. Tenant-scoped queries sign a " +
        "customer_id claim with it, and the RLS policies read that claim; " +
        "without it there is no safe client to fall back to (see .env.example).",
    );
  }
  if (!UUID_RE.test(customerId)) {
    // The database would fail closed on a malformed claim anyway (0009's regex
    // guard), returning zero rows. Throwing here instead turns a silent empty
    // page into a stack trace naming the caller that passed rubbish.
    throw new Error(
      "createTenantScopedClient requires a server-resolved customer UUID.",
    );
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // supabase-js only sets `Authorization` when the request does not already
      // carry one (`fetchWithAuth`, verified against @supabase/supabase-js
      // 2.106.2), so this header reaches PostgREST intact on every `from()` and
      // `rpc()` call. `apikey` still comes from the anon key above.
      headers: { Authorization: `Bearer ${mintTenantToken(customerId, jwtSecret)}` },
    },
  });
}
