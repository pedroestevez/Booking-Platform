import "server-only";

import Stripe from "stripe";

/**
 * Server-only Stripe client.
 *
 * Lazily constructed so importing this module never touches the environment at
 * build time — the client is only created the first time a request actually
 * needs Stripe, keeping `next build` green when `STRIPE_SECRET_KEY` is unset.
 * The secret key must never reach a Client Component.
 */

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "Stripe is not configured: set STRIPE_SECRET_KEY in the environment " +
        "(see .env.example).",
    );
  }

  // Pin to the SDK's bundled API version (omit an explicit literal to avoid
  // drift between the SDK types and a hardcoded date).
  cached = new Stripe(key);
  return cached;
}

/** Whether Stripe is configured at all — lets UI degrade gracefully when not. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
