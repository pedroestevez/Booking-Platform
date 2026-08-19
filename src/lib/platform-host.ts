/**
 * Whether a request host is the platform's own address, as opposed to a
 * tenant's custom domain (ALI-115).
 *
 * A later phase's middleware needs to decide, per request, whether the
 * incoming `Host` header names the platform itself (in which case tenant
 * resolution stays route-based — `/<slug>`) or a tenant's `custom_domain`
 * (in which case it should resolve via `getTenantByHost` instead). This is
 * that decision, pulled into its own module — rather than inlined in
 * `middleware.ts` — specifically so it is independently unit-testable without
 * standing up the Next.js middleware runtime, mirroring `tenantIndexEnabled`
 * in `src/lib/tenant-index.ts`: a pure predicate over `NodeJS.ProcessEnv`,
 * defaulted to the real `process.env` so call sites read naturally but a test
 * can pass a fabricated env and assert the whole truth table without
 * mutating the process.
 *
 * Three things make a host "the platform" rather than a tenant's:
 *
 *   1. **`localhost` / `127.0.0.1`, any port.** Local development. The port is
 *      stripped before comparison, so `localhost:3000` and `127.0.0.1:54321`
 *      both match.
 *   2. **Any `*.vercel.app` host.** Covers both preview deployments and the
 *      raw production alias Vercel assigns every project. Safe to treat as
 *      platform unconditionally because no real tenant `custom_domain` can
 *      ever be a `*.vercel.app` value — the fixed convention tenants are
 *      provisioned under is `booking.<their-domain>.com` (see
 *      `scripts/provision-tenant.mjs`'s `--custom-domain` validation), which
 *      cannot collide with Vercel's own domain.
 *   3. **An exact match against the hostname of `NEXT_PUBLIC_APP_URL`** — the
 *      deployment's own canonical domain (e.g. `booking.aligncompass.com`).
 *
 * Anything else — including a tenant's `booking.<their-domain>.com` — is not
 * the platform host, and `false` is the fail-safe default: an unrecognised
 * host falls through to tenant-by-host resolution rather than being treated
 * as the platform's own route-based booking flow.
 */
export function isPlatformHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (hostname.endsWith(".vercel.app")) return true;
  const configured = new URL(
    env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ).hostname;
  return hostname === configured;
}
