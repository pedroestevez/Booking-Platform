import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EMAIL_OPERATION,
  sendBookingConfirmation,
} from "@/lib/email/booking-confirmation";
import {
  createResendProvider,
  getEmailProvider,
  sanitizeHeaderValue,
} from "@/lib/email/provider";
import { buildIcs } from "@/lib/ics";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getTenantById } from "@/lib/tenants";
import { FakeResend, RESEND_REJECTIONS } from "@/test/fake-resend";
import type { Booking, Tenant } from "@/lib/types";

/**
 * ALI-196 — the blind test-author's suite.
 *
 * Written by the `qa` seat from the issue's goal, invariant and definition of
 * done alone, with no access to the diff, the implementation or the PR. Its
 * value is that its statement of the behaviour is independent of the code that
 * has to satisfy it.
 *
 * ## Reconciliation, recorded honestly
 *
 * As authored it did not compile: the seat has no reader, so it guessed the
 * module layout (`@/lib/email/vendor`, `@/lib/email/send-booking-confirmation`,
 * `@/lib/email/subject`, `sendEmail`, `sanitizeEmailSubject`) and none of those
 * exist. **Every divergence was wire shape; not one was behavioural.** The
 * fixtures below are rewired to the real modules and the assertions are the
 * seat's own, unchanged in what they claim. That is the same divergence class
 * cycle 14's retro recorded for the previous blind suites.
 *
 * Two of its claims were not covered by the builder's own suite and are the
 * reason this file earns its place rather than being folded into it:
 * "criterion 3 (rejection path)" and "invariant: ... throws synchronously".
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/tenants", () => ({
  getTenantById: vi.fn(),
}));

vi.mock("@/lib/email/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/provider")>()),
  getEmailProvider: vi.fn(),
}));

const FROM = "bookings@example.test";
const BOUND_MS = 40;
/** Well past the bound: if the entry point is unbounded this is what fires. */
const PATIENCE_MS = 1_500;
const STILL_PENDING = "STILL-PENDING";

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "owner@northwind.test";
const GUEST_EMAIL = "ada@example.com";

let resend: FakeResend;
let errors: ReturnType<typeof vi.spyOn>;
let tenantMemberEmails: string[];

function tenant(timezone = "UTC"): Tenant {
  return {
    id: TENANT_ID,
    name: "Northwind Therapy",
    slug: "northwind",
    branding: { timezone },
  } as unknown as Tenant;
}

function booking(): Booking {
  return {
    id: BOOKING_ID,
    customerId: TENANT_ID,
    start: "2026-09-01T10:00:00.000Z",
    end: "2026-09-01T10:30:00.000Z",
    status: "confirmed",
  } as unknown as Booking;
}

function makeInput() {
  return {
    booking: booking(),
    service: { name: "Interview" },
    guest: { name: "Ada Lovelace", email: GUEST_EMAIL },
  } as Parameters<typeof sendBookingConfirmation>[0];
}

/** Just enough of the client for `resolveTenantRecipients`. */
function fakeSupabase(): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    returns: async () => ({
      data: tenantMemberEmails.map((email) => ({ email })),
      error: null,
    }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

/** Resolves to `STILL_PENDING` rather than hanging the runner. */
async function withPatience<T>(work: Promise<T>): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(STILL_PENDING), PATIENCE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every log record this run emitted about our booking. */
function recordsForBooking(): Array<Record<string, unknown>> {
  return (errors.mock.calls as unknown[][])
    .map((call) => call[1] as Record<string, unknown>)
    .filter((detail) => detail?.bookingId === BOOKING_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  resend = new FakeResend();
  tenantMemberEmails = [];

  vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase());
  vi.mocked(getTenantById).mockResolvedValue(tenant());
  vi.mocked(getEmailProvider).mockImplementation(() =>
    createResendProvider(resend, FROM, BOUND_MS),
  );

  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ALI-196 — outbound email send is bounded, isolated per-recipient, and never invalidates a stored booking", () => {
  it("criterion 1: a vendor call that never settles does not leave the confirmation entry point waiting indefinitely", async () => {
    resend.stallFor(GUEST_EMAIL);

    const outcome = await withPatience(sendBookingConfirmation(makeInput()));

    expect(outcome).not.toBe(STILL_PENDING);
  });

  it("criterion 2: a hung owner/admin notification send does not prevent or delay the guest's confirmation send", async () => {
    tenantMemberEmails = [OWNER];
    resend.stallFor(OWNER);

    const outcome = await withPatience(sendBookingConfirmation(makeInput()));

    expect(outcome).not.toBe(STILL_PENDING);
    // The guest's copy was attempted and accepted despite the owner's stall.
    expect(resend.recipients()).toEqual([GUEST_EMAIL]);
    expect((outcome as { sent: number }).sent).toBe(1);
  });

  it("criterion 3: a timed-out send emits exactly one log record naming the booking id, with a reason distinguishable from a vendor rejection", async () => {
    resend.stallFor(GUEST_EMAIL);

    await withPatience(sendBookingConfirmation(makeInput()));

    const records = recordsForBooking();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: EMAIL_OPERATION,
      bookingId: BOOKING_ID,
      vendorCode: "timeout",
    });
  });

  it("criterion 3 (rejection path, faithful fake): an instant 422-style vendor rejection is logged with a reason distinct from the timeout reason", async () => {
    resend.rejectFor(GUEST_EMAIL, { ...RESEND_REJECTIONS.validation });

    const outcome = await withPatience(sendBookingConfirmation(makeInput()));

    expect(outcome).not.toBe(STILL_PENDING);
    const records = recordsForBooking();
    expect(records).toHaveLength(1);
    expect(records[0]!.vendorCode).toBe("validation_error");
    expect(records[0]!.vendorCode).not.toBe("timeout");
    // A rejection carries the vendor's status; a hang has none to carry.
    expect(records[0]!.vendorStatus).toBe(422);
  });

  it("criterion 4: driving a provider whose send never settles, the entry point returns within the bound and reports the same booking id it was given", async () => {
    resend.stallFor(GUEST_EMAIL);

    const outcome = await withPatience(sendBookingConfirmation(makeInput()));

    expect(outcome).not.toBe(STILL_PENDING);
    // Nothing was delivered, and the failure is attributed to this booking —
    // "booked but not emailed", the invariant's safe direction.
    expect(outcome).toMatchObject({ sent: 0, failed: 1 });
    expect(recordsForBooking()[0]!.bookingId).toBe(BOOKING_ID);
  });

  it("rider 5a: CR, LF, CRLF, and NUL in tenant-controlled text must not survive into the email Subject header", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    const hostile =
      "Confirmed" + CR + LF + "Bcc: victim@example.com" + CR + "x" + LF + "y" + NUL;

    const swept = sanitizeHeaderValue(hostile);

    expect(swept).not.toMatch(new RegExp("[" + CR + LF + NUL + "]"));
    expect(swept).toContain("Confirmed");
  });

  it("rider 5b: a lone carriage return (CR not followed by LF) in guest notes is neutralized by the .ics text escaper", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);

    const document = buildIcs({
      uid: BOOKING_ID + "@example.test",
      start: "2026-09-01T10:00:00.000Z",
      end: "2026-09-01T10:30:00.000Z",
      summary: "Interview",
      description: "before" + CR + "after",
    });

    // No raw CR survives except the CRLFs that delimit the document's lines.
    expect(document.split(CR + LF).join("")).not.toContain(CR);
    expect(document).toContain("before\\nafter");
  });

  it("rider 5c: an invalid/unrecognized tenant timezone does not throw out of the confirmation entry point", async () => {
    vi.mocked(getTenantById).mockResolvedValue(tenant("Not/AZone"));

    await expect(
      sendBookingConfirmation(makeInput()),
    ).resolves.toBeDefined();
  });

  it("invariant: the confirmation entry point never rejects, even when the vendor throws synchronously", async () => {
    vi.mocked(getEmailProvider).mockImplementation(() =>
      createResendProvider(
        {
          emails: {
            send: () => {
              throw new Error("vendor SDK exploded synchronously");
            },
          },
        } as never,
        FROM,
        BOUND_MS,
      ),
    );

    await expect(
      sendBookingConfirmation(makeInput()),
    ).resolves.toBeDefined();
  });
});
