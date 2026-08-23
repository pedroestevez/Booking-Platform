import "server-only";

import {
  EmailNotConfiguredError,
  EmailSendError,
  getEmailProvider,
  type EmailAttachment,
  type EmailProvider,
} from "@/lib/email/provider";
import { buildIcs, icsFilename, icsUid } from "@/lib/ics";
import { createTenantScopedClient } from "@/lib/supabase/server";
import { getTenantById, getTenantNotificationEmail } from "@/lib/tenants";
import type { Booking, GuestDetails, Tenant } from "@/lib/types";

/**
 * The confirmation email for a booking (ALI-69).
 *
 * ## The invariant this module exists to keep
 *
 * *No email ever claims a booking that is not durably stored, and no failed
 * **or hung** send ever invalidates a stored booking — or the request that
 * stored it.* The first half is the caller's: `createBooking` invokes this only
 * after the insert's `.single()` has resolved without error. The second half is
 * this module's, and it is why `sendBookingConfirmation` **never rejects** —
 * every failure is caught, counted and logged here, and the caller is handed an
 * outcome rather than an exception. The safe failure direction is "booked but
 * not emailed"; there is no path in this file that can produce "emailed but not
 * booked".
 *
 * ## Bounded, since ALI-196
 *
 * "Never rejects" was not enough on its own: a send that never *answers* also
 * never rejects, and until ALI-196 nothing here had a deadline. A stuck vendor
 * left `createBooking` unreturned past the invocation's own limit, so a booking
 * that was already committed reached the guest as a failure — and their retry
 * hit the overlap constraint against their own row. Two changes close it: every
 * send is bounded at the port (`DEFAULT_SEND_TIMEOUT_MS`), and the sends run
 * concurrently, so the bound is per-run rather than per-recipient.
 *
 * ## Recipients come from the booking's own tenant, never from configuration
 *
 * The guest is `input.guest.email`. The tenant side is `tenant_members.email`
 * for `role in ('owner','admin')`, scoped by the booking's `customer_id` — the
 * CLAUDE.md defense-in-depth filter — **plus**, since ALI-224, the tenant's own
 * `branding_json.notification_email` when it has one set.
 *
 * That second source does not weaken the rule this paragraph used to state. The
 * rule is that there is no *fallback* address: not an env var, not a hardcoded
 * one, because an env var holding one person's address is customer data baked
 * into the platform and it breaks the moment there is a second tenant.
 * `notification_email` is neither — it lives on the tenant's own row, so tenant
 * #2 gets its own or gets none.
 *
 * It exists because `tenant_members` is an **auth** mapping: every row carries a
 * Clerk `auth_subject`, so it is really "people who can sign in to this tenant",
 * and ALI-224 recorded the decision to defer Clerk (ALI-62). Requiring a member
 * row in order to be told about a booking therefore couples *who gets notified*
 * to a sign-in system that does not exist yet — which is exactly why the live
 * tenant had zero owner notifications: not a broken send path, an empty
 * `tenant_members` table. Both sources are read, unioned and de-duplicated
 * case-insensitively, so an address held both ways still gets exactly one copy.
 *
 * Guest and tenant get **separate sends**. One message with both addresses in
 * `to` would disclose each party's address to the other and would make a single
 * vendor rejection lose both notifications.
 *
 * ## What reaches the log
 *
 * Booking id, tenant id, which recipient *role* failed, and the vendor's
 * status/code — never a recipient address, never message bodies, never key
 * material. Vendor text is passed through `redactSensitive` before it is
 * logged, because a validation error commonly quotes the address that failed
 * it. An operator can find any of this from the booking id; the log does not
 * need to carry it a second time.
 */

/** Names this module's records in the log. */
export const EMAIL_OPERATION = "booking-confirmation-email";

/**
 * Which side of the booking a send was addressed to.
 *
 * `notification` is distinct from `tenant` on purpose (ALI-224): both are
 * owner-facing copies of the same message, but they come from different places
 * — `tenant_members` rows versus one `branding_json` key — and when one fails,
 * the log has to say which, because the fix is different.
 */
export type RecipientRole = "tenant" | "guest" | "notification";

/** Why a run sent nothing, when it sent nothing. */
export type SkipReason =
  | "not-confirmed"
  | "invalid-invite"
  | "not-configured"
  | "tenant-unresolved";

export interface BookingConfirmationOutcome {
  /** Sends the vendor accepted. */
  sent: number;
  /** Sends the vendor refused. Each was logged once. */
  failed: number;
  /** Set when nothing was attempted at all. */
  skipped?: SkipReason;
}

export interface BookingConfirmationInput {
  /** The stored row, as returned by the insert. */
  booking: Booking;
  /** The tenant's own service row (name only — the price is not in the email). */
  service: { name: string };
  /** The guest details this request supplied. */
  guest: GuestDetails;
}

/** Email addresses and anything key-shaped, removed from text bound for a log. */
export function redactSensitive(text: string): string {
  return text
    .replace(/re_[A-Za-z0-9_-]{4,}/g, "[redacted-key]")
    .replace(/[^\s<>"',;:]+@[^\s<>"',;:]+\.[^\s<>"',;:]+/g, "[redacted-email]");
}

/** Escape for interpolation into the HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One record, one `console.error`. Never a summary line plus a detail line. */
function logSendFailure(
  booking: Booking,
  role: RecipientRole,
  err: unknown,
): void {
  const vendor =
    err instanceof EmailSendError
      ? { vendorStatus: err.statusCode, vendorCode: err.vendorCode }
      : { vendorStatus: null, vendorCode: null };

  console.error(
    `[${EMAIL_OPERATION}] ${role} email failed for booking ${booking.id} — ` +
      "the booking itself is stored and unaffected.",
    {
      operation: EMAIL_OPERATION,
      bookingId: booking.id,
      customerId: booking.customerId,
      recipient: role,
      ...vendor,
      error: redactSensitive(
        err instanceof Error ? err.message : String(err),
      ),
    },
  );
}

/**
 * The addresses that manage this tenant.
 *
 * Read through the tenant-scoped client, so the `tenant_members` policies —
 * not this query alone — decide what comes back; the `.eq("customer_id", …)`
 * stays as the second layer (ALI-116). `role in ('owner','admin')` excludes `staff`, who are
 * members of the tenant but not the party a booking notification is for.
 */
export async function resolveTenantRecipients(
  customerId: string,
): Promise<string[]> {
  const supabase = createTenantScopedClient(customerId);
  const { data, error } = await supabase
    .from("tenant_members")
    .select("email")
    .eq("customer_id", customerId)
    .in("role", ["owner", "admin"])
    .returns<Array<{ email: string | null }>>();

  if (error) throw error;

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const row of data ?? []) {
    const email = row.email?.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(email);
  }
  return addresses;
}

/**
 * Does this look enough like an address to be worth a send?
 *
 * Deliberately permissive — the vendor is the real validator, and duplicating
 * its rules here would only produce a second, subtly different answer. This
 * exists for one narrow purpose: `notification_email` is tenant-editable config
 * held to no schema (the same category as `branding_json.timezone`, which threw
 * a `RangeError` out of this module in ALI-196), so a typo'd value would
 * otherwise buy one guaranteed vendor rejection on *every* booking, forever,
 * logged as a send failure rather than as the configuration error it is.
 */
export function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

/**
 * The tenant's configured notification address, when it has a usable one that
 * is not already covered by a `tenant_members` row (ALI-224).
 *
 * Never throws: a failed lookup is logged and treated as "no address", because
 * this runs inside a function whose whole contract is that a notification
 * problem cannot cost the guest their confirmation.
 */
async function resolveNotificationRecipient(
  booking: Booking,
  alreadyAddressed: string[],
): Promise<string | null> {
  let configured: string | null;
  try {
    configured = await getTenantNotificationEmail(booking.customerId);
  } catch (err) {
    logSendFailure(booking, "notification", err);
    return null;
  }

  if (!configured) return null;

  if (!looksLikeEmailAddress(configured)) {
    console.error(
      `[${EMAIL_OPERATION}] tenant ${booking.customerId} has an unusable ` +
        `branding_json.notification_email, so no owner copy of booking ` +
        `${booking.id} was sent. Fix the value; the booking is stored and the ` +
        "guest was still emailed.",
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
        recipient: "notification",
        // Redacted for the same reason every other tenant-authored string in
        // this module is: it is an address, and addresses do not reach the log.
        configuredNotificationEmail: redactSensitive(configured),
      },
    );
    return null;
  }

  // One copy per human, not one per source. A tenant that both has an owner
  // `tenant_members` row and names the same address here gets a single email.
  const covered = new Set(alreadyAddressed.map((a) => a.toLowerCase()));
  if (covered.has(configured.toLowerCase())) return null;

  return configured;
}

/**
 * When and where the appointment is, in the tenant's own timezone.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on a timezone string it does not
 * recognise, and `branding_json.timezone` is tenant-editable config, so this is
 * reachable from data rather than from a bug. It falls back to UTC rather than
 * propagating: a confirmation that names the time in the wrong zone, labelled
 * with the zone it used, beats no confirmation at all — and the alternative was
 * an exception escaping a function whose contract is that it never rejects
 * (ALI-196 rider 5).
 */
function formatWhen(booking: Booking, tenant: Tenant): string {
  const configured = tenant.branding.timezone;
  let timeZone = configured;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    console.error(
      `[${EMAIL_OPERATION}] tenant ${booking.customerId} has an unusable ` +
        `branding timezone; the confirmation for booking ${booking.id} states ` +
        "times in UTC instead. Fix branding_json.timezone.",
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
        // Redacted like every other free text this module logs: the rule at
        // the top of the file is that tenant-authored text is held to no
        // schema, and a timezone field is no more trustworthy than a vendor
        // message. Flagged by the ALI-196 security pass (observation B).
        configuredTimezone: redactSensitive(configured),
      },
    );
    timeZone = "UTC";
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  });
  return `${formatter.format(new Date(booking.start))} (${timeZone})`;
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

/**
 * The owner's notification — the resume-critical half of release 0.1.
 *
 * Pedro's ruling, recorded on the issue: *"it needs to put something on my
 * calendar, maybe, or at least send me an email."* So this message leads with
 * who booked what and when, and carries the invite so his calendar is one click
 * away.
 */
function renderTenantEmail(
  input: BookingConfirmationInput,
  tenant: Tenant,
  when: string,
): Rendered {
  const { booking, service, guest } = input;
  const lines = [
    `${guest.name} booked ${service.name}.`,
    "",
    `When:  ${when}`,
    `Who:   ${guest.name} <${guest.email}>`,
    ...(guest.notes ? ["", `Notes: ${guest.notes}`] : []),
    "",
    "The calendar invite is attached.",
    `Booking reference: ${booking.id}`,
  ];

  return {
    subject: `New booking — ${service.name}, ${when}`,
    text: lines.join("\n"),
    html: [
      `<p><strong>${escapeHtml(guest.name)}</strong> booked ${escapeHtml(service.name)}.</p>`,
      "<ul>",
      `<li><strong>When:</strong> ${escapeHtml(when)}</li>`,
      `<li><strong>Who:</strong> ${escapeHtml(guest.name)} (${escapeHtml(guest.email)})</li>`,
      ...(guest.notes
        ? [`<li><strong>Notes:</strong> ${escapeHtml(guest.notes)}</li>`]
        : []),
      "</ul>",
      "<p>The calendar invite is attached.</p>",
      `<p style="color:#666;font-size:12px">Booking reference: ${escapeHtml(booking.id)}</p>`,
    ].join("\n"),
  };
}

/** The guest's copy. Carries no tenant-member address — see "separate sends". */
function renderGuestEmail(
  input: BookingConfirmationInput,
  tenant: Tenant,
  when: string,
): Rendered {
  const { booking, service, guest } = input;
  const lines = [
    `Hi ${guest.name},`,
    "",
    `Your ${service.name} with ${tenant.name} is confirmed.`,
    "",
    `When: ${when}`,
    "",
    "The calendar invite is attached — open it to add the appointment to your calendar.",
    `Booking reference: ${booking.id}`,
  ];

  return {
    subject: `Your ${service.name} with ${tenant.name} is confirmed`,
    text: lines.join("\n"),
    html: [
      `<p>Hi ${escapeHtml(guest.name)},</p>`,
      `<p>Your <strong>${escapeHtml(service.name)}</strong> with ${escapeHtml(tenant.name)} is confirmed.</p>`,
      `<p><strong>When:</strong> ${escapeHtml(when)}</p>`,
      "<p>The calendar invite is attached — open it to add the appointment to your calendar.</p>",
      `<p style="color:#666;font-size:12px">Booking reference: ${escapeHtml(booking.id)}</p>`,
    ].join("\n"),
  };
}

/**
 * The invite, built from the **stored** row.
 *
 * `booking.start`/`booking.end` are what the database returned, not what the
 * request asked for, so the attachment cannot describe a time other than the one
 * reserved. Throws `InvalidIcsInstantError` if either is not a real instant.
 */
function buildInvite(
  input: BookingConfirmationInput,
  tenant: Tenant,
): EmailAttachment {
  const { booking, service, guest } = input;
  const description = [`Booked for ${guest.name} (${guest.email}).`];
  if (guest.notes) description.push(guest.notes);

  const ics = buildIcs({
    uid: icsUid(booking.id),
    start: booking.start,
    end: booking.end,
    summary: `${service.name} with ${tenant.name}`,
    description: description.join("\n\n"),
    location: tenant.name,
  });

  return {
    filename: icsFilename(`${service.name}-${tenant.name}`),
    contentBase64: Buffer.from(ics, "utf8").toString("base64"),
    contentType: "text/calendar",
  };
}

/**
 * Notify the tenant and the guest that a booking is confirmed.
 *
 * **Never rejects.** Every failure is contained, logged once, and reported in
 * the returned outcome. The caller's booking is already stored by the time this
 * runs and nothing here may change that.
 */
export async function sendBookingConfirmation(
  input: BookingConfirmationInput,
): Promise<BookingConfirmationOutcome> {
  const { booking } = input;

  // The guard is also at the call site (ALI-69 AC1). It is repeated here so the
  // module is safe for the second confirmation path to reuse (ALI-181) without
  // that path having to re-derive the rule.
  if (booking.status !== "confirmed") {
    return { sent: 0, failed: 0, skipped: "not-confirmed" };
  }

  let tenant: Tenant | null;
  try {
    tenant = await getTenantById(booking.customerId);
  } catch (err) {
    logSendFailure(booking, "tenant", err);
    return { sent: 0, failed: 0, skipped: "tenant-unresolved" };
  }
  if (!tenant) {
    console.error(
      `[${EMAIL_OPERATION}] tenant ${booking.customerId} did not resolve — ` +
        `nobody was notified of booking ${booking.id}. The booking is stored.`,
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
      },
    );
    return { sent: 0, failed: 0, skipped: "tenant-unresolved" };
  }

  // Built before anything is addressed, so an unbuildable invite costs zero
  // sends rather than one good send and one refusal (ALI-69 AC5).
  let invite: EmailAttachment;
  try {
    invite = buildInvite(input, tenant);
  } catch (err) {
    console.error(
      `[${EMAIL_OPERATION}] refusing to send booking ${booking.id}: its ` +
        "calendar invite could not be built, and an email cannot be recalled. " +
        "The booking is stored and unaffected.",
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
        error: redactSensitive(err instanceof Error ? err.message : String(err)),
      },
    );
    return { sent: 0, failed: 0, skipped: "invalid-invite" };
  }

  let provider: EmailProvider;
  try {
    provider = getEmailProvider();
  } catch (err) {
    // AC6 — unconfigured is loud, and it is loud *here*, once, rather than as
    // an exception escaping a booking that already succeeded.
    console.error(
      `[${EMAIL_OPERATION}] email is not configured — nobody was notified of ` +
        `booking ${booking.id}. The booking is stored. ` +
        (err instanceof EmailNotConfiguredError ? err.message : ""),
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
      },
    );
    return { sent: 0, failed: 0, skipped: "not-configured" };
  }

  let tenantRecipients: string[] = [];
  try {
    tenantRecipients = await resolveTenantRecipients(booking.customerId);
  } catch (err) {
    // A failed lookup must not cost the guest their copy, so this is logged and
    // the run continues with an empty tenant list.
    logSendFailure(booking, "tenant", err);
  }

  // ALI-224. Resolved after the member lookup because it de-duplicates against
  // it, and never throws — an owner copy is the thing this whole block is for,
  // but it is still a side effect of a booking that is already stored.
  const notificationRecipient = await resolveNotificationRecipient(
    booking,
    tenantRecipients,
  );

  if (tenantRecipients.length === 0 && !notificationRecipient) {
    // AC3's specified state, and it was production reality until ALI-224: the
    // live tenant had zero `tenant_members` rows, so this line — not a broken
    // send — is why the owner never heard about a booking. Deliberately
    // legible, and now it names both ways to fix it.
    console.warn(
      `[${EMAIL_OPERATION}] no owner or admin address for tenant ` +
        `${booking.customerId}, so nobody was notified of booking ` +
        `${booking.id}. Set branding_json.notification_email on the customers ` +
        "row, or add a tenant_members row with role 'owner' or 'admin'. The " +
        "booking is stored and the guest was still emailed.",
      {
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: booking.customerId,
        tenantRecipients: 0,
        notificationRecipient: false,
      },
    );
  }

  const when = formatWhen(booking, tenant);
  const attachments = [invite];

  const outcome: BookingConfirmationOutcome = { sent: 0, failed: 0 };

  /** One send, isolated: its failure can cost only itself. */
  async function deliver(
    to: string,
    role: RecipientRole,
    rendered: Rendered,
  ): Promise<void> {
    try {
      await provider.send({
        to,
        fromName: tenant!.name,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        attachments,
      });
      outcome.sent += 1;
    } catch (err) {
      outcome.failed += 1;
      logSendFailure(booking, role, err);
    }
  }

  // Concurrently, not in sequence (ALI-196 B1). Each `deliver` is already
  // isolated — it never throws, and it is now bounded by the provider's
  // timeout — so running them together costs nothing and removes the failure
  // this issue was filed for: a first tenant address that hangs used to hold
  // the guest's copy behind it for the full duration, so one stuck send made
  // the whole request late rather than one notification late. Worst case is now
  // one timeout, not one per recipient.
  const tenantEmail = renderTenantEmail(input, tenant, when);
  const guestEmail = renderGuestEmail(input, tenant, when);

  await Promise.all([
    ...tenantRecipients.map((address) =>
      deliver(address, "tenant", tenantEmail),
    ),
    // The owner copy rides this same run rather than waiting on the guest's
    // send to resolve first. ALI-224 AC1 reads "when a booking's confirmation
    // send succeeds", and gating on that literally would mean Pedro hears about
    // *fewer* bookings precisely when delivery is broken — the opposite of what
    // an owner notification is for. It is one more isolated recipient on the
    // already-verified path, which is also what keeps the ALI-196 bound
    // per-run rather than per-recipient.
    ...(notificationRecipient
      ? [deliver(notificationRecipient, "notification", tenantEmail)]
      : []),
    deliver(input.guest.email, "guest", guestEmail),
  ]);

  return outcome;
}
