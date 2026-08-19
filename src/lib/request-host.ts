import "server-only";

import { headers } from "next/headers";

/**
 * Resolve the host a request arrived on, normalized to the exact form
 * `customers.custom_domain` is required to be stored in (migration 0008's
 * lowercase check constraint) — so a caller can compare the two directly with
 * no normalization of its own.
 *
 * Mirrors `getOrigin()` in `src/app/admin/(dashboard)/payments/actions.ts` —
 * the one existing header-read in this codebase — for which header wins:
 * `x-forwarded-host` first, falling back to `host`. Vercel (and any proxy in
 * front of this app) sets `x-forwarded-host`; `host` alone is only what a
 * client connecting directly would send.
 *
 * `x-forwarded-host` is a comma-separated list when multiple proxies are in
 * the chain, each appending its own value — the FIRST entry is what the
 * client originally asked for, which is the one that matters for tenant
 * routing (this app must never trust an *intermediate* hop's rewritten host).
 *
 * Normalization: lowercase (host headers are case-insensitive per RFC 4343),
 * a trailing dot stripped (a FQDN's root-label dot — `example.com.` and
 * `example.com` name the same host), and a trailing `:port` stripped (a
 * customer's own domain is compared with no port; Vercel's routing already
 * resolved the port before this code runs).
 *
 * Returns `null` when there is no usable host at all (both headers absent or
 * blank) — callers must treat that as "definitely not a custom domain",
 * never guess or fall back to a default host, because guessing here is
 * exactly the kind of ambiguity `getTenantByHost` cannot safely resolve.
 */
export async function resolveRequestHost(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-host");
  const raw = (forwarded ? forwarded.split(",")[0] : null)?.trim() || h.get("host");

  if (!raw) return null;

  const withoutPort = raw.replace(/:\d+$/, "");
  const withoutTrailingDot = withoutPort.replace(/\.$/, "");
  const normalized = withoutTrailingDot.trim().toLowerCase();

  return normalized || null;
}

/**
 * Hosts this deployment itself is reachable at — deployment-level facts, not
 * customer data, the same split `TenantBranding.contactEmail` draws between a
 * tenant's own configuration and something the platform decides.
 *
 * `getTenantByHost` (a database round trip) is skipped entirely for these:
 * the platform's own hosts are never a tenant's `custom_domain` — that would
 * be requiring a customer to prove ownership of infrastructure they don't
 * control (ALI-212, domain ownership verification, precludes it either way).
 */
export const PLATFORM_SHARED_HOSTS = new Set(["booking.aligncompass.com", "localhost"]);

/**
 * True for the platform's own hosts: the production shared host, any Vercel
 * preview/deployment host (`*.vercel.app`), and `localhost` for local dev.
 * `host` must already be normalized (see `resolveRequestHost`) — this does no
 * normalization of its own.
 */
export function isPlatformSharedHost(host: string): boolean {
  return PLATFORM_SHARED_HOSTS.has(host) || host.endsWith(".vercel.app");
}
