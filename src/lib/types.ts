/**
 * Domain types for the booking platform.
 *
 * These mirror the Supabase schema (see `supabase/migrations/`) so that when we
 * swap mock data for real reads in the next milestone, the UI layer doesn't
 * change. Every entity is scoped by `customerId` — the app never operates on a
 * row without knowing which tenant it belongs to.
 */

/** Per-tenant white-label configuration (maps to `customers.branding_json`). */
export interface TenantBranding {
  /** Accent color as an oklch/hex/CSS color string, applied as `--brand`. */
  brandColor: string;
  /** Optional logo URL shown in the booking header. */
  logoUrl?: string;
  /** Short tagline rendered under the business name. */
  tagline?: string;
  /** ISO 4217 currency code used for prices, e.g. "USD". */
  currency: string;
  /** IANA timezone the business operates in, e.g. "America/New_York". */
  timezone: string;
}

/** A bookable business (maps to `customers`). */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  branding: TenantBranding;
}

/** A business-owner's role within a tenant (maps to `tenant_members.role`). */
export type TenantRole = "owner" | "admin" | "staff";

/**
 * Links a signed-in admin user (Clerk `auth_subject`) to a tenant they manage
 * (maps to `tenant_members`). Auth is decoupled from RLS: the server resolves
 * this mapping, then scopes every query by `customerId` as usual.
 */
export interface TenantMember {
  id: string;
  customerId: string;
  /** External auth identity — the Clerk user id ("user_…"). */
  authSubject: string;
  email: string;
  role: TenantRole;
}

/** A bookable service (maps to `services`). */
export interface Service {
  id: string;
  customerId: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  active: boolean;
}

/** A weekly recurring availability window (maps to `availability_rules`). */
export interface AvailabilityRule {
  id: string;
  customerId: string;
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** "HH:mm" 24h local to the tenant timezone. */
  startTime: string;
  /** "HH:mm" 24h local to the tenant timezone. */
  endTime: string;
  /** Gap enforced after each booking, in minutes. */
  bufferMinutes: number;
}

/** A one-off blocked window that overrides availability (maps to `blocked_slots`). */
export interface BlockedSlot {
  id: string;
  customerId: string;
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant. */
  end: string;
  reason?: string;
}

/**
 * Variable, per-vertical intake captured at booking time (e.g. bags/passengers
 * for transfers, pet breed for grooming). Stored as `bookings.custom_fields`
 * JSONB — data, not schema — so new verticals add fields without migrations.
 */
export type CustomFields = Record<string, unknown>;

/**
 * A guest of a tenant as a reusable identity (maps to `end_customers`). Keyed
 * per tenant by email so the same person resolves to one record across bookings
 * (and, later, orders/courses).
 */
export interface EndCustomer {
  id: string;
  customerId: string;
  email: string;
  name: string;
  phone?: string;
  metadata: Record<string, unknown>;
}

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed";

/** A reservation (maps to `bookings`). */
export interface Booking {
  id: string;
  customerId: string;
  serviceId: string;
  /** The guest's resolved identity (`end_customers.id`). */
  endCustomerId: string;
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant. */
  end: string;
  notes?: string;
  status: BookingStatus;
  /** Per-vertical intake captured at booking time. */
  customFields: CustomFields;
}

/** Input for creating a booking (server action). Identity is resolved by email. */
export interface CreateBookingInput {
  customerId: string;
  serviceId: string;
  slot: TimeSlot;
  guest: GuestDetails;
  customFields?: CustomFields;
}

/** A concrete, selectable time slot derived from rules minus blocks/bookings. */
export interface TimeSlot {
  /** ISO 8601 instant for the slot start. */
  start: string;
  /** ISO 8601 instant for the slot end. */
  end: string;
}

/** Guest-supplied details collected in the booking form. */
export interface GuestDetails {
  name: string;
  email: string;
  notes?: string;
}
