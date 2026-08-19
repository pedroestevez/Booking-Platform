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
  /**
   * Where a guest can reach this business directly, as a plain address.
   *
   * Optional on purpose: it is the fallback contact path the product offers
   * when an automated notification could not be sent (see
   * `BookingConfirmation`). A tenant that sets nothing simply gets no contact
   * button — never a hard-coded one.
   */
  contactEmail?: string;
}

/** A bookable business (maps to `customers`). */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  branding: TenantBranding;
  /**
   * The host (e.g. `booking.pedroestevez.com`) this tenant is addressed at
   * directly, without a `/<slug>` prefix (maps to `customers.custom_domain`,
   * ALI-211). A `customers` column, not tenant-controlled config — deliberately
   * **not** nested inside `branding`, unlike `logoUrl`/`tagline`/etc., because a
   * tenant does not get to set which host routes to it; only provisioning
   * (and, later, ALI-212's ownership-verified admin path) does.
   *
   * Undefined for the common case — a tenant addressed only by slug.
   */
  customDomain?: string;
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
 *
 * One key inside it is **reserved and server-authoritative**: `guest_supplied`
 * (`GUEST_SUPPLIED_FIELD` in `src/lib/bookings.ts`). See `GuestSupplied`.
 */
export type CustomFields = Record<string, unknown>;

/**
 * What a booking request supplied for the guest's `name`/`phone` where it
 * **differed** from the identity it resolved to (ALI-167).
 *
 * Since 0007 an anonymous request can attach a booking to an existing
 * `end_customers` row but can never alter that row's `name` or `phone`. The
 * supplied values are not therefore discarded — silently dropping them
 * reproduces the same failure from the other side, where the owner reads the
 * dashboard, sees the stored name, and has no trace of what the booker
 * actually typed. They are per-request facts, so they are recorded on the
 * per-request row: `bookings.custom_fields.guest_supplied`.
 *
 * Written only when the request resolved to a **pre-existing** identity and
 * supplied a non-empty value that differs from the stored one; first contact
 * records nothing, because there the stored value *is* the supplied one.
 *
 * ## Untrusted display data
 *
 * These are unvalidated attacker-controlled strings (ALI-167 R1) — no more
 * exposure than `custom_fields` already carries, but any admin view that
 * renders them must treat them as untrusted, and must never substitute them
 * into the guest-name position. The guest's name is the one stored on the
 * referenced identity, always.
 */
export interface GuestSupplied {
  name?: string;
  phone?: string;
}

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

/**
 * What the browser is allowed to send to `createBookingAction` (ALI-139).
 *
 * There is deliberately **no `customerId`** here. The tenant a booking lands in
 * is resolved server-side from the slug (`getTenantBySlug`); a UUID posted by
 * the browser is not an input to that decision, it is an attack. Removing the
 * field is what makes the compiler enforce it: the old shape carried
 * `customerId` straight through to a client that bypasses RLS, so any visitor
 * could write rows into — and squat the calendar of — any other tenant.
 *
 * ## Why a slug is trustworthy input where a UUID is not
 *
 * Posting tenant B's *slug* asks for exactly what visiting tenant B's public
 * booking page asks for: a public action, available to anyone with a browser.
 * Posting tenant B's *UUID from tenant A's page* asks the server to write into
 * a tenant the request has no relationship with. The slug is a public page
 * identity that the server then resolves through the database; the UUID was an
 * unchecked assertion of authority. That asymmetry is the whole fix.
 *
 * ## Why this is spelled out rather than derived from `CreateBookingInput`
 *
 * Writing it as `Omit<CreateBookingInput, "customerId"> & {…}` would be
 * shorter, but it would mean a field added to the internal type silently
 * widens what the browser may send. At a trust boundary the explicit list is
 * the point — adding to it should be a deliberate edit.
 */
export interface CreateBookingRequest {
  /**
   * The tenant's public slug — the `[customerSlug]` route segment the guest is
   * booking on. Resolved to a `customer_id` server-side; never trusted as one.
   */
  customerSlug: string;
  serviceId: string;
  slot: TimeSlot;
  guest: GuestDetails;
  customFields?: CustomFields;
}

/**
 * Input for `createBooking` — the internal, already-trusted shape. Identity is
 * resolved by email.
 *
 * `customerId` here is a **server-resolved** id (from `getTenantBySlug`, or a
 * `tenant_members` lookup on the admin side), never a value that arrived from a
 * browser. The type cannot express that distinction on its own, which is why
 * the browser-facing `CreateBookingRequest` above simply has no such field.
 */
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
