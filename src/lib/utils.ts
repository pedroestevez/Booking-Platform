import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a price stored in integer cents as a localized currency string. */
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
