-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0008 — Per-tenant custom domain                                            ║
-- ║                                                                            ║
-- ║ Nullable, and most tenants never set it: the default is still the shared   ║
-- ║ `<platform-domain>/<slug>` address every tenant already has. A tenant that ║
-- ║ wants their own domain (fixed convention: `booking.<their-domain>.com`)     ║
-- ║ has it recorded here so a later phase's middleware can resolve request     ║
-- ║ host → tenant instead of route segment → tenant.                           ║
-- ║                                                                            ║
-- ║ A plain `unique` index already allows unlimited NULLs in Postgres (NULL    ║
-- ║ is never equal to NULL for uniqueness purposes), so no partial index with  ║
-- ║ a `where custom_domain is not null` clause is needed — every tenant that   ║
-- ║ has not set one coexists under the same index without conflict.            ║
-- ║                                                                            ║
-- ║ Values are stored lowercase and trimmed by convention, enforced by         ║
-- ║ `scripts/provision-tenant.mjs` at write time — NOT by a CHECK constraint   ║
-- ║ here. Lookups (`getTenantByHost`) do an exact match with zero              ║
-- ║ normalization of their own, so a value that reached this column any other ║
-- ║ way (a hand-run `update`, a future admin UI) must itself already be        ║
-- ║ lowercase/trimmed or it will simply never match a real request host.       ║
-- ║                                                                            ║
-- ║ References ALI-115.                                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table public.customers
  add column if not exists custom_domain text;

create unique index if not exists customers_custom_domain_key
  on public.customers (custom_domain);
