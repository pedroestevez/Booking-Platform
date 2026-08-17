import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a monetary **amount** stored in integer cents as a localized currency
 * string. Zero formats as a real amount (`$0`), which is correct for an amount:
 * a dashboard reporting revenue of zero must say `$0`, not "Free".
 *
 * For a service's price, use `formatServicePrice` instead.
 */
export function formatPrice(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** What a `price_cents = 0` service is labelled, everywhere a price is shown. */
export const FREE_PRICE_LABEL = "Free";

/**
 * Format a **service's price**, where zero means the service is free
 * (ALI-176 criterion 5).
 *
 * Release 0.1's two services are both `price_cents = 0`, so this is the label a
 * real visitor reads on the first live booking page. `$0` is well-formed but
 * wrong copy: it reads as a transaction of nothing rather than as "no payment
 * needed", and it sits next to a flow that asks for no card. Anything non-zero
 * is unchanged — same currency, same locale, same rounding as `formatPrice`.
 *
 * Deliberately separate from `formatPrice` rather than a zero-case inside it:
 * the two callers mean different things by zero. `formatPrice` also renders
 * *amounts* (the admin's booked-revenue KPI), where "Free" would be nonsense.
 */
export function formatServicePrice(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  return cents === 0 ? FREE_PRICE_LABEL : formatPrice(cents, currency, locale);
}

/** Human-friendly duration, e.g. 90 -> "1 hr 30 min", 45 -> "45 min". */
export function formatDuration(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins} min`;
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}

/** Date label in a tenant's timezone, e.g. "Mon, Jun 23". */
export function formatDate(
  iso: string,
  timeZone = "UTC",
  locale = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(iso));
}

/** Time label in a tenant's timezone, e.g. "2:30 PM". */
export function formatTime(
  iso: string,
  timeZone = "UTC",
  locale = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}
