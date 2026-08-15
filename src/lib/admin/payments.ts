import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe/server";

/**
 * Stripe Connect (Express) for a tenant. This app is the platform; each
 * tenant connects their own Express account and receives booking payments
 * directly, with an optional per-tenant application fee routed to the platform.
 *
 * Reads here are plain DB reads (no Stripe call) so the admin page renders even
 * when Stripe is unconfigured; the Stripe API is only touched by the explicit
 * onboarding / refresh actions.
 */

export interface PaymentSettings {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  /** Platform fee in basis points (250 = 2.5%). */
  platformFeeBps: number;
}

interface PaymentSettingsRow {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  platform_fee_bps: number;
}

export async function getPaymentSettings(
  customerId: string,
): Promise<PaymentSettings> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("stripe_account_id, stripe_charges_enabled, platform_fee_bps")
    .eq("id", customerId)
    .single<PaymentSettingsRow>();

  if (error) throw error;
  return {
    stripeAccountId: data.stripe_account_id,
    chargesEnabled: data.stripe_charges_enabled,
    platformFeeBps: data.platform_fee_bps,
  };
}

async function patchCustomer(
  customerId: string,
  patch: Partial<PaymentSettingsRow>,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("customers")
    .update(patch)
    .eq("id", customerId);
  if (error) throw error;
}

/**
 * Begin (or resume) Express onboarding: ensure the tenant has a connected
 * account, then return a one-time Account Link URL to Stripe's hosted
 * onboarding. `origin` is the absolute app origin for the return/refresh URLs.
 */
export async function startOnboarding(
  customerId: string,
  origin: string,
): Promise<string> {
  const stripe = getStripe();
  const settings = await getPaymentSettings(customerId);

  let accountId = settings.stripeAccountId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      metadata: { customer_id: customerId },
    });
    accountId = account.id;
    await patchCustomer(customerId, { stripe_account_id: accountId });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/admin/payments?refresh=1`,
    return_url: `${origin}/admin/payments?onboarded=1`,
    type: "account_onboarding",
  });
  return link.url;
}

/** Sync `charges_enabled` from Stripe into the tenant row. Returns the new value. */
export async function refreshAccountStatus(
  customerId: string,
): Promise<boolean> {
  const settings = await getPaymentSettings(customerId);
  if (!settings.stripeAccountId) return false;

  const account = await getStripe().accounts.retrieve(settings.stripeAccountId);
  const enabled = Boolean(account.charges_enabled);
  if (enabled !== settings.chargesEnabled) {
    await patchCustomer(customerId, { stripe_charges_enabled: enabled });
  }
  return enabled;
}

/** A one-time link into the tenant's Express dashboard. */
export async function createDashboardLink(customerId: string): Promise<string> {
  const settings = await getPaymentSettings(customerId);
  if (!settings.stripeAccountId) {
    throw new Error("No connected Stripe account yet.");
  }
  const link = await getStripe().accounts.createLoginLink(
    settings.stripeAccountId,
  );
  return link.url;
}

/** Set the platform fee (basis points, clamped 0–10000 = 0–100%). */
export async function setPlatformFeeBps(
  customerId: string,
  bps: number,
): Promise<void> {
  const clamped = Math.max(0, Math.min(10000, Math.round(bps)));
  await patchCustomer(customerId, { platform_fee_bps: clamped });
}
