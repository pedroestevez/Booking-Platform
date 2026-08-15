import "server-only";

import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  BookingStatus,
  CustomFields,
  Service,
  Tenant,
  TenantBranding,
  TenantMember,
  TenantRole,
} from "@/lib/types";

/**
 * Database row shapes (snake_case, as returned by PostgREST) and mappers to the
 * camelCase domain types the UI uses. Hand-written to match the existing
 * convention in `src/lib/types.ts` — no generated `database.types.ts`.
 */

export interface CustomerRow {
  id: string;
  name: string;
  slug: string;
  branding_json: Record<string, unknown>;
}

export interface ServiceRow {
  id: string;
  customer_id: string;
  name: string;
  description: string;
  duration_minutes: number;
  price_cents: number;
  active: boolean;
}

export interface AvailabilityRuleRow {
  id: string;
  customer_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  buffer_minutes: number;
}

export interface BlockedSlotRow {
  id: string;
  customer_id: string;
  start_time: string;
  end_time: string;
  reason: string | null;
}

export interface BookingRow {
  id: string;
  customer_id: string;
  service_id: string;
  end_customer_id: string;
  start_time: string;
  end_time: string;
  notes: string | null;
  status: BookingStatus;
  custom_fields: CustomFields;
}

export interface TenantMemberRow {
  id: string;
  customer_id: string;
  auth_subject: string;
  email: string;
  role: TenantRole;
}

export function mapTenant(row: CustomerRow): Tenant {
  // branding_json is tenant-controlled config; default the required fields so a
  // partially-configured tenant still renders.
  const b = row.branding_json as Partial<TenantBranding>;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    branding: {
      brandColor: b.brandColor ?? "oklch(0.55 0.16 250)",
      logoUrl: b.logoUrl,
      tagline: b.tagline,
      currency: b.currency ?? "USD",
      timezone: b.timezone ?? "UTC",
    },
  };
}

export function mapService(row: ServiceRow): Service {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    description: row.description,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    active: row.active,
  };
}

export function mapAvailabilityRule(row: AvailabilityRuleRow): AvailabilityRule {
  return {
    id: row.id,
    customerId: row.customer_id,
    dayOfWeek: row.day_of_week,
    // Postgres `time` comes back as "HH:MM:SS"; the slot engine expects "HH:mm".
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    bufferMinutes: row.buffer_minutes,
  };
}

export function mapBlockedSlot(row: BlockedSlotRow): BlockedSlot {
  return {
    id: row.id,
    customerId: row.customer_id,
    start: row.start_time,
    end: row.end_time,
    reason: row.reason ?? undefined,
  };
}

export function mapBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    customerId: row.customer_id,
    serviceId: row.service_id,
    endCustomerId: row.end_customer_id,
    start: row.start_time,
    end: row.end_time,
    notes: row.notes ?? undefined,
    status: row.status,
    customFields: row.custom_fields ?? {},
  };
}

export function mapTenantMember(row: TenantMemberRow): TenantMember {
  return {
    id: row.id,
    customerId: row.customer_id,
    authSubject: row.auth_subject,
    email: row.email,
    role: row.role,
  };
}
