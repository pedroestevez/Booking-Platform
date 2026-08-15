-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0005 — Stripe Connect (Express) per tenant                                 ║
-- ║                                                                            ║
-- ║ Multi-tenant payments: each tenant connects their OWN Stripe **Express**   ║
-- ║ account and receives booking payments directly. This app is the             ║
-- ║ platform; an optional per-tenant application fee routes a cut to the         ║
-- ║ platform on each connected charge.                                          ║
-- ║                                                                            ║
-- ║   • stripe_account_id       — the connected account ("acct_…").             ║
-- ║   • stripe_charges_enabled  — mirrors the account's charges_enabled, so     ║
-- ║     the booking flow only takes payment once onboarding is complete.        ║
-- ║   • platform_fee_bps        — the platform's cut in basis points (250 =      ║
-- ║     2.5%). 0 for tenants who pay upfront; >0 for revenue-share tenants.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table public.customers
  add column if not exists stripe_account_id text;

alter table public.customers
  add column if not exists stripe_charges_enabled boolean not null default false;

alter table public.customers
  add column if not exists platform_fee_bps integer not null default 0
    check (platform_fee_bps between 0 and 10000);
