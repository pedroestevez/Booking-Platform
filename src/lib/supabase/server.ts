import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase access.
 *
 * SSR reads/writes go through the **service-role** client. Per CLAUDE.md the
 * service-role key bypasses RLS to bootstrap the slug → customer lookup; every
 * tenant-scoped query then *also* filters by `customer_id` in app code (the
 * mandated defense-in-depth filter), centralized in `src/lib/tenants.ts`. RLS
 * and the `app.current_customer_id` GUC remain enforced for the public/anon API
 * surface. The service-role key must NEVER reach a Client Component.
 */

let cached: SupabaseClient | null = null;

export function createServiceRoleClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in the environment (see .env.example).",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
