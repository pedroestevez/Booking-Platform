/**
 * Stands in for `@/lib/email/provider`, which is `server-only` and pulls in the
 * Resend Node SDK.
 *
 * `TenantBookingPage` uses it for exactly one thing: the boolean
 * `notificationsEnabled` prop, which is read on the *confirmation* step. It
 * contributes nothing to the schedule step's layout.
 */
export function isEmailConfigured(): boolean {
  return false;
}
