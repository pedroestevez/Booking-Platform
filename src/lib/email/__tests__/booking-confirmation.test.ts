import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import {
  EMAIL_OPERATION,
  escapeHtml,
  redactSensitive,
  resolveTenantRecipients,
  sendBookingConfirmation,
} from "@/lib/email/booking-confirmation";
import {
  EmailNotConfiguredError,
  createResendProvider,
  getEmailProvider,
} from "@/lib/email/provider";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  fakeResolveOrCreateEndCustomer,
  type FakeEndCustomerRow,
} from "@/test/fake-identity-rpc";
import { FakeResend, RESEND_REJECTIONS } from "@/test/fake-resend";
import type { Booking, CreateBookingInput } from "@/lib/types";

/**
 * The confirmation email (ALI-69) — AC1 through AC6.
 *
 * The vendor is the only thing faked at the seam: `getEmailProvider` is mocked
 * to return the **real** `createResendProvider` over the **faithful** Resend
 * fake, so recipient resolution, the template, the attachment, the port's
 * error normalization and the call site's isolation are all production code
 * here. Only the HTTP call to resend.com is not.
 *
 * `src/lib/email/__tests__/provider.test.ts` owns the other half: the proof
 * that the fake refuses what the real Resend refuses. Without that suite these
 * assertions would only describe a vendor that says yes to everything.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

// Only `getEmailProvider` is replaced. `createResendProvider`, `formatFrom` and
// both error classes stay real — mocking those would test the mock.
vi.mock("@/lib/email/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/provider")>()),
  getEmailProvider: vi.fn(),
}));

const FROM = "bookings@example.test";

const TENANT_A = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Northwind Therapy",
  slug: "northwind",
  owner: "owner-a@northwind.test",
  admin: "admin-a@northwind.test",
  staff: "staff-a@northwind.test",
  freeService: "a5e40001-0000-4000-8000-000000000001",
  paidService: "a5e40001-0000-4000-8000-000000000002",
};

const TENANT_B = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Rival Wellness",
  slug: "rival",
  owner: "owner-b@rival.test",
  freeService: "b5e40001-0000-4000-8000-000000000001",
};

const GUEST = { name: "Ada Lovelace", email: "ada@example.com" };

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T10:30:00.000Z",
};

interface Row {
  [column: string]: unknown;
}

/** The tables this path touches, plus `tenant_members` for the recipient read. */
class FakeDatabase {
  readonly customers: Row[] = [
    {
      id: TENANT_A.id,
      name: TENANT_A.name,
      slug: TENANT_A.slug,
      branding_json: { timezone: "UTC" },
    },
    {
      id: TENANT_B.id,
      name: TENANT_B.name,
      slug: TENANT_B.slug,
      branding_json: { timezone: "UTC" },
    },
  ];

  readonly services: Row[] = [
    service(TENANT_A.freeService, TENANT_A.id, "Interview — 30 min", 0),
    service(TENANT_A.paidService, TENANT_A.id, "Deep Session", 5000),
    service(TENANT_B.freeService, TENANT_B.id, "Rival Intro", 0),
  ];

  /** Seeded per test — deliberately empty by default (AC3's negative case). */
  readonly tenant_members: Row[] = [];
  readonly availability_rules: Row[] = [];
  readonly blocked_slots: Row[] = [];
  readonly end_customers: FakeEndCustomerRow[] = [];
  readonly bookings: Row[] = [];

  /** When set, the next insert fails with this PostgREST error. */
  failInsertWith: { code: string; message: string } | null = null;
  /** When set, the stored row echoes this `start_time` (AC5's bad instant). */
  storedStartTime: string | null = null;

  table(name: string): Row[] {
    const t = (this as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(t)) throw new Error(`fake: unknown table "${name}"`);
    return t;
  }

  member(customerId: string, email: string, role: string): void {
    this.tenant_members.push({
      id: `member-${this.tenant_members.length + 1}`,
      customer_id: customerId,
      auth_subject: `user_${this.tenant_members.length + 1}`,
      email,
      role,
    });
  }

  booking(id: string): Row | undefined {
    return this.bookings.find((b) => b.id === id);
  }
}

function service(
  id: string,
  customerId: string,
  name: string,
  priceCents: number,
): Row {
  return {
    id,
    customer_id: customerId,
    name,
    description: "",
    duration_minutes: 30,
    price_cents: priceCents,
    active: true,
  };
}

type Filter = (row: Row) => boolean;

/** A chainable PostgREST-shaped builder (the shape ALI-139/167's suites use). */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Filter[] = [];
  private pendingInsert: Row | null = null;

  constructor(
    private readonly db: FakeDatabase,
    private readonly tableName: string,
  ) {}

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  returns<T>(): FakeQuery & PromiseLike<{ data: T; error: unknown }> {
    return this as unknown as FakeQuery &
      PromiseLike<{ data: T; error: unknown }>;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  insert(row: Row): this {
    this.pendingInsert = row;
    return this;
  }

  private rows(): Row[] {
    return this.db
      .table(this.tableName)
      .filter((row) => this.filters.every((f) => f(row)));
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: unknown }> {
    if (this.pendingInsert) {
      const pending = this.pendingInsert;
      this.pendingInsert = null;
      if (this.db.failInsertWith) {
        const error = this.db.failInsertWith;
        this.db.failInsertWith = null;
        return { data: null, error };
      }
      const stored: Row = {
        id: `booking-${this.db.table(this.tableName).length + 1}`,
        ...pending,
        ...(this.db.storedStartTime
          ? { start_time: this.db.storedStartTime }
          : {}),
      };
      this.db.table(this.tableName).push(stored);
      return { data: stored, error: null };
    }
    return { data: this.rows()[0] ?? null, error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>)
      | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.rows(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

function fakeSupabase(db: FakeDatabase): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(db, table),
    rpc: async (_fn: string, args: Record<string, unknown>) =>
      fakeResolveOrCreateEndCustomer(db, args),
  } as unknown as SupabaseClient;
}

let db: FakeDatabase;
let resend: FakeResend;
let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDatabase();
  resend = new FakeResend();

  vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase(db));
  vi.mocked(generateDaySlots).mockReturnValue([
    { start: SLOT.start, end: SLOT.end },
  ]);
  vi.mocked(getEmailProvider).mockImplementation(() =>
    createResendProvider(resend, FROM),
  );

  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function input(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    customerId: TENANT_A.id,
    serviceId: TENANT_A.freeService,
    slot: SLOT,
    guest: { ...GUEST },
    ...overrides,
  };
}

/** The decoded `.ics` the vendor received on the nth accepted send. */
function decodedInvite(index = 0): string {
  const attachment = resend.sent[index]!.attachments![0]!;
  return Buffer.from(attachment.content, "base64").toString("utf8");
}

/** The one field of an iCalendar document, unfolded. */
function icsField(document: string, name: string): string | undefined {
  return document
    .split("\r\n")
    .find((line) => line.startsWith(`${name}:`))
    ?.slice(name.length + 1);
}

/** `2026-09-01T10:00:00.000Z` → `20260901T100000Z`, derived independently. */
function expectedIcsInstant(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/**
 * Invariant (c): every email the fake received corresponds to a stored booking
 * with that id and status `confirmed`.
 *
 * Asserted from the attachment's own `UID` rather than from a variable the test
 * is holding, so it checks what the recipient would actually be told.
 */
function everyEmailMatchesAStoredConfirmedBooking(): void {
  expect(resend.sent.length).toBeGreaterThan(0);
  for (let i = 0; i < resend.sent.length; i += 1) {
    const uid = icsField(decodedInvite(i), "UID")!;
    const bookingId = uid.split("@")[0]!;
    const stored = db.booking(bookingId);
    expect(stored, `no stored booking for emailed UID ${uid}`).toBeDefined();
    expect(stored!.status).toBe("confirmed");
  }
}

// ── AC1 ──────────────────────────────────────────────────────────────────────
describe("AC1 — a send happens only after the row is durably stored", () => {
  it("sends the guest exactly one email for a confirmed booking", async () => {
    const booking = await createBooking(input());

    expect(booking.status).toBe("confirmed");
    expect(resend.recipients()).toEqual([GUEST.email]);
    everyEmailMatchesAStoredConfirmedBooking();
  });

  // A paid service still inserts `pending` (ALI-176). Saying "confirmed" about
  // a slot held pending payment would be a lie the guest acts on.
  it("sends nothing for a pending booking", async () => {
    const booking = await createBooking(
      input({ serviceId: TENANT_A.paidService }),
    );

    expect(booking.status).toBe("pending");
    expect(resend.sent).toHaveLength(0);
  });

  // The ordering half of the invariant: the 23P01 loser of a real race never
  // reaches the send, because the throw happens above it.
  it("sends nothing when the insert loses the overlap race (23P01)", async () => {
    db.failInsertWith = {
      code: "23P01",
      message: 'conflicting key value violates exclusion constraint "bookings_no_overlap"',
    };

    await expect(createBooking(input())).rejects.toThrow(
      "Sorry, that time was just taken. Please pick another.",
    );
    expect(resend.sent).toHaveLength(0);
    expect(db.bookings).toHaveLength(0);
  });

  it("sends nothing when the insert fails for any other reason", async () => {
    db.failInsertWith = {
      code: "23503",
      message: "insert or update violates foreign key constraint",
    };

    await expect(createBooking(input())).rejects.toBeTruthy();
    expect(resend.sent).toHaveLength(0);
  });

  it("sends nothing when the slot is refused before the insert", async () => {
    vi.mocked(generateDaySlots).mockReturnValue([]);

    await expect(createBooking(input())).rejects.toThrow(
      "Sorry, that time was just taken. Please pick another.",
    );
    expect(resend.sent).toHaveLength(0);
  });

  it("sends nothing when the service is gone", async () => {
    await expect(
      createBooking(input({ serviceId: "99999999-9999-4999-8999-999999999999" })),
    ).rejects.toThrow("That service is no longer available.");
    expect(resend.sent).toHaveLength(0);
  });

  // The module guards on status too, so the second confirmation path (ALI-181)
  // inherits the rule rather than re-deriving it.
  it("refuses to send for a non-confirmed booking handed to it directly", async () => {
    const pending: Booking = {
      id: "booking-x",
      customerId: TENANT_A.id,
      serviceId: TENANT_A.freeService,
      endCustomerId: "end-customer-1",
      start: SLOT.start,
      end: SLOT.end,
      status: "pending",
      customFields: {},
    };

    const outcome = await sendBookingConfirmation({
      booking: pending,
      service: { name: "Interview — 30 min" },
      guest: GUEST,
    });

    expect(outcome).toEqual({ sent: 0, failed: 0, skipped: "not-confirmed" });
    expect(resend.sent).toHaveLength(0);
  });
});

// ── AC2 ──────────────────────────────────────────────────────────────────────
describe("AC2 — the attachment is a real calendar document", () => {
  beforeEach(() => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
  });

  it("decodes to a VCALENDAR whose UID carries the booking id", async () => {
    const booking = await createBooking(input());
    const invite = decodedInvite();

    expect(invite.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(invite).toContain("END:VCALENDAR");
    expect(icsField(invite, "UID")).toContain(booking.id);
  });

  it("carries DTSTART/DTEND equal to the stored times, to the second", async () => {
    const booking = await createBooking(input());
    const stored = db.booking(booking.id)!;
    const invite = decodedInvite();

    expect(icsField(invite, "DTSTART")).toBe(
      expectedIcsInstant(stored.start_time as string),
    );
    expect(icsField(invite, "DTEND")).toBe(
      expectedIcsInstant(stored.end_time as string),
    );
    // …and those are the times the database returned, not the ones requested.
    expect(stored.start_time).toBe(SLOT.start);
  });

  it("uses CRLF line endings, as RFC 5545 requires", async () => {
    await createBooking(input());
    const invite = decodedInvite();

    expect(invite).toContain("\r\n");
    // No bare LF anywhere: every newline is preceded by a CR.
    expect(/[^\r]\n/.test(invite)).toBe(false);
  });

  it("is attached as text/calendar under an .ics filename", async () => {
    await createBooking(input());
    const attachment = resend.sent[0]!.attachments![0]!;

    expect(attachment.contentType).toBe("text/calendar");
    expect(attachment.filename).toMatch(/\.ics$/);
  });

  it("stays METHOD:PUBLISH — this is an invite, not an RSVP request", async () => {
    await createBooking(input());

    expect(decodedInvite()).toContain("METHOD:PUBLISH");
    expect(decodedInvite()).not.toContain("METHOD:REQUEST");
  });

  it("gives both parties the same invite, so one appointment appears once", async () => {
    await createBooking(input());

    expect(resend.sent).toHaveLength(2);
    expect(icsField(decodedInvite(0), "UID")).toBe(
      icsField(decodedInvite(1), "UID"),
    );
  });

  it("never emits a NaN instant", async () => {
    await createBooking(input());

    expect(decodedInvite()).not.toContain("NaN");
  });
});

// ── AC3 ──────────────────────────────────────────────────────────────────────
describe("AC3 — recipients derive from the booking's own tenant", () => {
  it("emails both the tenant owner and the guest, in separate sends", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");

    await createBooking(input());

    expect(resend.recipients().sort()).toEqual(
      [TENANT_A.owner, GUEST.email].sort(),
    );
    // Separate sends: one address per message, so neither party learns the
    // other's from the headers.
    for (const payload of resend.sent) {
      expect(payload.to).not.toContain(",");
    }
    const guestMessage = resend.sent.find((p) => p.to === GUEST.email)!;
    expect(guestMessage.text).not.toContain(TENANT_A.owner);
    expect(guestMessage.html).not.toContain(TENANT_A.owner);
    everyEmailMatchesAStoredConfirmedBooking();
  });

  it("emails admins as well as owners, but never staff", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    db.member(TENANT_A.id, TENANT_A.admin, "admin");
    db.member(TENANT_A.id, TENANT_A.staff, "staff");

    await createBooking(input());

    expect(resend.recipients()).toContain(TENANT_A.owner);
    expect(resend.recipients()).toContain(TENANT_A.admin);
    expect(resend.recipients()).not.toContain(TENANT_A.staff);
  });

  // Today's production reality until a `tenant_members` row exists (ALI-177 P3).
  // A specified behaviour, not a bug — and the warning is what Pedro will read.
  it("still emails the guest with no tenant member, and warns once", async () => {
    const booking = await createBooking(input());

    expect(resend.recipients()).toEqual([GUEST.email]);
    expect(warnings).toHaveBeenCalledTimes(1);

    const [message, payload] = warnings.mock.calls[0] as [string, Row];
    expect(message).toContain(booking.id);
    expect(message).toContain(TENANT_A.id);
    expect(message).toContain("tenant_members");
    expect(message).toMatch(/owner/);
    expect(payload).toMatchObject({
      operation: EMAIL_OPERATION,
      bookingId: booking.id,
      customerId: TENANT_A.id,
      tenantRecipients: 0,
    });
  });

  it("has no fallback address anywhere when the tenant has no member", async () => {
    vi.stubEnv("BOOKING_NOTIFICATION_EMAIL", "fallback@example.com");

    await createBooking(input());

    expect(resend.recipients()).toEqual([GUEST.email]);
    vi.unstubAllEnvs();
  });

  // Cross-tenant leakage — the risk `external-api` does not itself cover.
  it("never addresses another tenant's owner", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    db.member(TENANT_B.id, TENANT_B.owner, "owner");

    await createBooking(input());

    expect(resend.recipients()).not.toContain(TENANT_B.owner);
    expect(JSON.stringify(resend.sent)).not.toContain(TENANT_B.owner);
    expect(JSON.stringify(resend.sent)).not.toContain(TENANT_B.name);
  });

  it("scopes the recipient query by customer_id in app code", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    db.member(TENANT_B.id, TENANT_B.owner, "owner");

    await expect(resolveTenantRecipients(TENANT_A.id)).resolves.toEqual([
      TENANT_A.owner,
    ]);
    await expect(resolveTenantRecipients(TENANT_B.id)).resolves.toEqual([
      TENANT_B.owner,
    ]);
  });

  it("addresses a booking in tenant B to tenant B's owner only", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    db.member(TENANT_B.id, TENANT_B.owner, "owner");

    await createBooking(
      input({ customerId: TENANT_B.id, serviceId: TENANT_B.freeService }),
    );

    expect(resend.recipients().sort()).toEqual(
      [TENANT_B.owner, GUEST.email].sort(),
    );
    expect(resend.recipients()).not.toContain(TENANT_A.owner);
  });

  it("de-duplicates an address held by two roles", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    db.member(TENANT_A.id, TENANT_A.owner.toUpperCase(), "admin");

    await createBooking(input());

    expect(
      resend.recipients().filter((r) => r.toLowerCase() === TENANT_A.owner),
    ).toHaveLength(1);
  });

  it("sends from the configured address under the tenant's own name", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");

    await createBooking(input());

    expect(resend.sent[0]!.from).toBe(`"${TENANT_A.name}" <${FROM}>`);
  });
});

// ── AC4 — the criterion with teeth ───────────────────────────────────────────
describe("AC4 — a Resend rejection never invalidates the booking", () => {
  beforeEach(() => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
  });

  it.each([
    ["401 unauthorized", RESEND_REJECTIONS.unauthorized, 401],
    ["422 validation", RESEND_REJECTIONS.validation, 422],
    ["429 rate limited", RESEND_REJECTIONS.rateLimited, 429],
  ])(
    "survives a %s rejection: booking returned, one log, other send unharmed",
    async (_label, rejection, status) => {
      resend.rejectFor(GUEST.email, rejection);

      // No exception escapes `createBooking` — the booking is returned normally.
      const booking = await createBooking(input());

      expect(booking.id).toEqual(expect.any(String));
      expect(booking.status).toBe("confirmed");
      // The slot is not released: the row is still there, still occupying.
      expect(db.booking(booking.id)).toBeDefined();
      expect(db.booking(booking.id)!.status).toBe("confirmed");

      // Exactly one record, carrying the booking id and the vendor's error.
      expect(errors).toHaveBeenCalledTimes(1);
      const [message, payload] = errors.mock.calls[0] as [string, Row];
      expect(message).toContain(booking.id);
      expect(payload).toMatchObject({
        operation: EMAIL_OPERATION,
        bookingId: booking.id,
        customerId: TENANT_A.id,
        recipient: "guest",
        vendorStatus: status,
        vendorCode: rejection.name,
      });

      // Per-send isolation: the owner still heard about the booking.
      expect(resend.recipients()).toEqual([TENANT_A.owner]);
    },
  );

  it("logs one record per failed send when every send is refused", async () => {
    resend.rejectFor(GUEST.email, RESEND_REJECTIONS.rateLimited);
    resend.rejectFor(TENANT_A.owner, RESEND_REJECTIONS.rateLimited);

    const booking = await createBooking(input());

    expect(booking.status).toBe("confirmed");
    expect(resend.sent).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(2);
    for (const call of errors.mock.calls) {
      expect(call[0]).toContain(booking.id);
    }
  });

  it("keeps a transport fault inside createBooking too", async () => {
    vi.mocked(getEmailProvider).mockImplementation(() =>
      createResendProvider(
        {
          emails: {
            send: async () => {
              throw new Error("fetch failed: ECONNREFUSED");
            },
          },
        },
        FROM,
      ),
    );

    const booking = await createBooking(input());

    expect(booking.status).toBe("confirmed");
    expect(db.booking(booking.id)).toBeDefined();
    expect(errors.mock.calls.length).toBeGreaterThan(0);
  });

  // The log is for an operator, and an operator can find the addresses from the
  // booking id. Vendor text routinely quotes the address that failed validation.
  it("never puts a recipient address or key material in the log", async () => {
    resend.rejectFor(GUEST.email, RESEND_REJECTIONS.validation);
    resend.rejectFor(TENANT_A.owner, {
      message: "API key re_abcdef123456 is invalid for owner-a@northwind.test",
      name: "invalid_api_key",
      statusCode: 401,
    });

    await createBooking(input());

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(GUEST.email);
    expect(logged).not.toContain(TENANT_A.owner);
    expect(logged).not.toContain("re_abcdef123456");
    expect(logged).toContain("[redacted-email]");
    expect(logged).toContain("[redacted-key]");
  });

  it("does not leak the guest's name or notes into the log", async () => {
    resend.rejectFor(GUEST.email, RESEND_REJECTIONS.validation);

    await createBooking(
      input({
        guest: { ...GUEST, notes: "I have a confidential medical condition" },
      }),
    );

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("confidential medical condition");
    expect(logged).not.toContain(GUEST.name);
  });
});

// ── AC5 ──────────────────────────────────────────────────────────────────────
describe("AC5 — a malformed .ics is never sent", () => {
  beforeEach(() => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
  });

  it("refuses every send when the stored start time is not an instant", async () => {
    db.storedStartTime = "not-a-date";

    const booking = await createBooking(input());

    // Zero sends — not one good send and one refusal.
    expect(resend.sent).toHaveLength(0);
    // …and the booking stands.
    expect(booking.id).toEqual(expect.any(String));
    expect(db.booking(booking.id)).toBeDefined();

    expect(errors).toHaveBeenCalledTimes(1);
    const [message] = errors.mock.calls[0] as [string];
    expect(message).toContain(booking.id);
    expect(message).toMatch(/calendar invite could not be built/);
  });

  it("reports the refusal as a skip, never as a send", async () => {
    const outcome = await sendBookingConfirmation({
      booking: {
        id: "booking-bad",
        customerId: TENANT_A.id,
        serviceId: TENANT_A.freeService,
        endCustomerId: "end-customer-1",
        start: "2026-09-01T10:00:00.000Z",
        end: "not-a-date",
        status: "confirmed",
        customFields: {},
      },
      service: { name: "Interview — 30 min" },
      guest: GUEST,
    });

    expect(outcome).toEqual({ sent: 0, failed: 0, skipped: "invalid-invite" });
    expect(resend.sent).toHaveLength(0);
  });

  it("never sends an attachment containing NaN", async () => {
    db.storedStartTime = "not-a-date";

    await createBooking(input());

    expect(JSON.stringify(resend.sent)).not.toContain("NaN");
    expect(resend.sent).toHaveLength(0);
  });
});

// ── AC6 ──────────────────────────────────────────────────────────────────────
describe("AC6 — unconfigured is loud, and costs no booking", () => {
  it("keeps the booking and logs that email is not configured", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");
    vi.mocked(getEmailProvider).mockImplementation(() => {
      throw new EmailNotConfiguredError("RESEND_API_KEY");
    });

    const booking = await createBooking(input());

    expect(booking.status).toBe("confirmed");
    expect(db.booking(booking.id)).toBeDefined();
    expect(resend.sent).toHaveLength(0);

    expect(errors).toHaveBeenCalledTimes(1);
    const [message] = errors.mock.calls[0] as [string];
    expect(message).toContain("not configured");
    expect(message).toContain(booking.id);
  });

  it("does not pretend to have sent anything", async () => {
    vi.mocked(getEmailProvider).mockImplementation(() => {
      throw new EmailNotConfiguredError("RESEND_API_KEY");
    });

    const outcome = await sendBookingConfirmation({
      booking: {
        id: "booking-y",
        customerId: TENANT_A.id,
        serviceId: TENANT_A.freeService,
        endCustomerId: "end-customer-1",
        start: SLOT.start,
        end: SLOT.end,
        status: "confirmed",
        customFields: {},
      },
      service: { name: "Interview — 30 min" },
      guest: GUEST,
    });

    expect(outcome).toEqual({ sent: 0, failed: 0, skipped: "not-configured" });
  });

  // The environment this suite runs in has no key, which is the point: every
  // criterion above was proved with `RESEND_API_KEY` unset.
  it("runs this whole suite with no Resend key present", () => {
    expect(process.env.RESEND_API_KEY ?? "").toBe("");
  });
});

// ── The two helpers the log and the template rest on ─────────────────────────
describe("redactSensitive", () => {
  it("removes addresses and key-shaped strings", () => {
    expect(redactSensitive("failed for ada@example.com")).toBe(
      "failed for [redacted-email]",
    );
    expect(redactSensitive("key re_ABC123def is invalid")).toBe(
      "key [redacted-key] is invalid",
    );
  });

  it("leaves text with nothing sensitive in it alone", () => {
    expect(redactSensitive("Too many requests.")).toBe("Too many requests.");
  });
});

describe("escapeHtml", () => {
  // Guest name and notes are unvalidated attacker-controlled strings (ALI-167
  // R1) and they land in an HTML body an email client renders.
  it("neutralises markup in guest-supplied text", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  // The ampersand leg has to be asserted on its own, and first: without it the
  // other four replacements are reversible, because `&lt;` written into text
  // that already contained `&amp;lt;` decodes back to `<` in the client.
  it("escapes the ampersand, so the other escapes cannot be undone", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
    expect(escapeHtml("&#60;")).toBe("&amp;#60;");
  });

  it("escapes the guest's notes in the message that reaches the tenant", async () => {
    db.member(TENANT_A.id, TENANT_A.owner, "owner");

    await createBooking(
      input({
        guest: { ...GUEST, name: "<script>alert(1)</script>", notes: "<b>hi</b>" },
      }),
    );

    const tenantMessage = resend.sent.find((p) => p.to === TENANT_A.owner)!;
    expect(tenantMessage.html).not.toContain("<script>");
    expect(tenantMessage.html).toContain("&lt;script&gt;");
    expect(tenantMessage.html).not.toContain("<b>hi</b>");
  });
});
