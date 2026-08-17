import { PostgrestError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GUEST_FACING_MESSAGES,
  genericFailureMessage,
  logUnexpectedFailure,
  toGuestFacingMessage,
} from "@/lib/errors";

/**
 * The mapping layer, in isolation (ALI-140).
 *
 * `bookings.conflict.test.ts` drives the same rule end to end through
 * `createBookingAction`. This suite owns the parts that are properties of the
 * mapping itself and would be tedious to enumerate through a fake driver: what
 * the generic message may contain, that the correlation id in it is the one in
 * the log, that a *single* record is emitted, and that the record is worth
 * having for an operator.
 *
 * ## The forbidden-token list is the criterion, written out
 *
 * ALI-140's criterion is "no SQL identifier, table name, constraint name, or
 * env-var name". `FORBIDDEN_TOKENS` is that sentence made checkable, drawn from
 * the real strings this codebase can produce: table and column names from
 * migrations 0001/0003, constraint names from 0003/0006, the identity function
 * from 0007, and the two env vars `createServiceRoleClient` names. Every token
 * is checked case-insensitively against every generic message this suite
 * produces.
 *
 * The reference is stripped before that check, and deliberately so: it is a
 * random v4 UUID, so a hex run inside it could contain a short token like a
 * SQLSTATE by chance and make an otherwise sound assertion flake. Stripping the
 * one substring the code *intends* to be there keeps the sweep about leakage.
 */

const FORBIDDEN_TOKENS = [
  // Tables and columns.
  "bookings",
  "end_customers",
  "customers",
  "services",
  "availability_rules",
  "blocked_slots",
  "tenant_members",
  "customer_id",
  "end_customer_id",
  "service_id",
  "start_time",
  "custom_fields",
  // Constraints and functions.
  "bookings_no_overlap",
  "end_customers_customer_id_email_key",
  "end_customers_customer_id_fkey",
  "bookings_service_id_fkey",
  "resolve_or_create_end_customer",
  "constraint",
  "relation",
  "violates",
  "not-null",
  // SQLSTATEs.
  "23502",
  "23503",
  "23P01",
  "40001",
  // Env vars and machinery.
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "service_role",
  "supabase",
  "postgres",
  "postgrest",
  "row-level security",
  "sqlstate",
  "search_path",
  ".env",
] as const;

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** The reference the generic message carries, or `null` if it carries none. */
function referenceIn(message: string): string | null {
  return message.match(UUID_PATTERN)?.[0] ?? null;
}

/**
 * Assert `message` names none of the machinery.
 *
 * Returns the reference it found, so a caller can go straight on to check it
 * against the log record — the two halves of the criterion are one line apart.
 */
function expectNoLeak(message: string): string {
  const reference = referenceIn(message);
  expect(reference).not.toBeNull();

  const withoutReference = message.replace(reference!, "<reference>");
  for (const token of FORBIDDEN_TOKENS) {
    expect(withoutReference.toLowerCase()).not.toContain(token.toLowerCase());
  }
  return reference!;
}

/** Every console channel, so "exactly one record" can mean exactly that. */
function spyOnConsole() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  };
}

let consoleSpies: ReturnType<typeof spyOnConsole>;

beforeEach(() => {
  consoleSpies = spyOnConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The structured half of the log record. */
interface LogPayload {
  reference: string;
  operation: string;
  error: Record<string, unknown>;
}

/**
 * The one log record — asserting on the way out that it is the only one.
 *
 * Read structurally rather than as serialized text: the driver's messages are
 * full of double quotes, and comparing them against a JSON dump would be an
 * assertion about escaping rather than about content.
 */
function soleLogRecord(): { summary: string; payload: LogPayload } {
  expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  expect(consoleSpies.warn).not.toHaveBeenCalled();
  expect(consoleSpies.log).not.toHaveBeenCalled();
  expect(consoleSpies.info).not.toHaveBeenCalled();
  expect(consoleSpies.debug).not.toHaveBeenCalled();

  const call = consoleSpies.error.mock.calls[0]!;
  return {
    summary: String(call[0]),
    payload: call[1] as unknown as LogPayload,
  };
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const GUEST_EMAIL = "ada@example.test";

/**
 * The real 40001 from migration 0007 (ALI-167 security pass, S2).
 *
 * 0007's fallback `raise exception` interpolates `p_customer_id` and `v_email`
 * into its message, so this text is *ours* and still discloses a tenant UUID and
 * a guest's email address. It reaches the boundary as an ordinary
 * `PostgrestError`, which is exactly why the mapping cannot be a filter on
 * driver wording. (Documented-unreachable under READ COMMITTED — the mapping is
 * not allowed to depend on that, which is what this case exists to prove.)
 */
const raisedIdentityException = () =>
  new PostgrestError({
    message:
      "resolve_or_create_end_customer: identity for " +
      `(${TENANT_ID}, ${GUEST_EMAIL}) neither found nor created`,
    details: "",
    hint: "A concurrent insert is not visible to this snapshot; retry the request.",
    code: "40001",
  });

const foreignKeyViolation = () =>
  new PostgrestError({
    message:
      'insert or update on table "bookings" violates foreign key constraint ' +
      '"bookings_service_id_fkey"',
    details: 'Key (service_id)=(…) is not present in table "services".',
    hint: "",
    code: "23503",
  });

const misconfiguration = () =>
  new Error(
    "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY in the environment (see .env.example).",
  );

describe("toGuestFacingMessage — an allowlisted message passes through", () => {
  it.each([...GUEST_FACING_MESSAGES].map((m) => [m] as const))(
    "returns %o verbatim",
    (message) => {
      expect(toGuestFacingMessage(new Error(message), "op")).toBe(message);
    },
  );

  it("logs nothing for one: it is an expected outcome, not a fault", () => {
    toGuestFacingMessage(new Error("That service is no longer available."), "op");

    // "Exactly one record per unexpected failure" only means something if the
    // expected refusals — which happen on every taken slot — stay silent.
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.log).not.toHaveBeenCalled();
  });

  it("holds the whole inventory of guest-facing copy, and nothing else", () => {
    // The set is an allowlist, so its *size* is part of the contract: a fourth
    // sentence appearing here without a matching throw site, or a wildcard entry,
    // widens what a guest can be told.
    expect([...GUEST_FACING_MESSAGES]).toEqual([
      "Sorry, that time was just taken. Please pick another.",
      "That service is no longer available.",
      "This booking page is no longer available.",
    ]);
  });

  it("matches on the whole message, not a prefix or a fragment", () => {
    // The dangerous near-miss for a `startsWith`/`includes` implementation: an
    // error that begins with allowlisted copy and then appends driver detail.
    const suffixed =
      "That service is no longer available. " +
      'relation "services" does not exist';

    const message = toGuestFacingMessage(new Error(suffixed), "op");

    expect(message).not.toBe(suffixed);
    expect(expectNoLeak(message)).toBeTruthy();
  });
});

interface UnexpectedCase {
  label: string;
  build: () => Error;
}

const UNEXPECTED_CASES: readonly UnexpectedCase[] = [
  { label: "a driver error (23503 foreign key)", build: foreignKeyViolation },
  {
    label: "a migration's own raise exception (40001, interpolated)",
    build: raisedIdentityException,
  },
  { label: "a misconfiguration naming env vars", build: misconfiguration },
  {
    label: "a programming error",
    build: () => new TypeError("Cannot read properties of null (reading 'id')"),
  },
];

describe("toGuestFacingMessage — everything else is replaced and logged", () => {
  it.each(UNEXPECTED_CASES.map((c) => [c.label, c] as const))(
    "%s → generic message + exactly one log record",
    (_label, testCase) => {
      const original = testCase.build();

      const message = toGuestFacingMessage(original, "createBookingAction");

      // Half one: nothing about the machinery reaches the caller…
      const reference = expectNoLeak(message);
      expect(message).toBe(genericFailureMessage(reference));
      expect(message).not.toContain(original.message);

      // …half two: one record, carrying the original error and the same id.
      const { summary, payload } = soleLogRecord();
      expect(summary).toContain(reference);
      expect(payload.reference).toBe(reference);
      expect(payload.operation).toBe("createBookingAction");
      expect(payload.error.message).toBe(original.message);
      expect(payload.error.name).toBe(original.name);
      expect(payload.error.stack).toEqual(expect.any(String));
    },
  );

  it("keeps the tenant UUID and the guest's email out of the 40001 message", () => {
    // S2 in full: the interpolated values *are* the disclosure, so they are
    // named explicitly here rather than left to the token sweep.
    const message = toGuestFacingMessage(raisedIdentityException(), "op");

    expect(message).not.toContain(TENANT_ID);
    expect(message).not.toContain(GUEST_EMAIL);
    expect(message).not.toContain("40001");

    // …and they are in the log, where the operator does need them.
    const { payload } = soleLogRecord();
    expect(payload.error.message).toContain(TENANT_ID);
    expect(payload.error.message).toContain(GUEST_EMAIL);
    expect(payload.error.code).toBe("40001");
  });

  it("records the SQLSTATE, details and hint the message cannot carry", () => {
    // PostgREST puts the key *values* in `details`, which is why `details` never
    // goes to a browser — and why dropping it from the log would throw away the
    // most diagnostic field on the object.
    toGuestFacingMessage(foreignKeyViolation(), "op");

    const { payload } = soleLogRecord();
    expect(payload.error.code).toBe("23503");
    expect(payload.error.details).toContain("is not present in table");
    expect(payload.error).toHaveProperty("hint");
  });

  it("unwraps one level of cause, so a wrapped fetch failure is legible", () => {
    // The realistic Supabase network fault: `TypeError: fetch failed`, with the
    // only useful sentence one level down.
    const wrapped = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:54321"),
    });

    const message = toGuestFacingMessage(wrapped, "op");

    expectNoLeak(message);
    const { payload } = soleLogRecord();
    expect(payload.error.cause).toMatchObject({
      message: "connect ECONNREFUSED 127.0.0.1:54321",
    });
  });
});

interface NonErrorCase {
  label: string;
  thrown: unknown;
  value: string;
}

const NON_ERROR_THROWS: readonly NonErrorCase[] = [
  { label: "a thrown string", thrown: "boom", value: "boom" },
  { label: "a thrown object", thrown: { code: "23503" }, value: "[object Object]" },
  { label: "undefined", thrown: undefined, value: "undefined" },
  { label: "null", thrown: null, value: "null" },
];

describe("toGuestFacingMessage — a thrown non-Error is still handled", () => {
  it.each(NON_ERROR_THROWS.map((c) => [c.label, c] as const))(
    "%s → generic message + exactly one log record",
    (_label, testCase) => {
      // The old code's blind spot: a non-Error fell through to a message with no
      // reference and no log at all, so the fault was invisible to both parties.
      const message = toGuestFacingMessage(testCase.thrown, "op");

      const reference = expectNoLeak(message);
      expect(message).toBe(genericFailureMessage(reference));

      const { payload } = soleLogRecord();
      expect(payload.reference).toBe(reference);
      expect(payload.error.value).toBe(testCase.value);
    },
  );
});

describe("the correlation id", () => {
  it("is different for every failure", () => {
    const first = toGuestFacingMessage(foreignKeyViolation(), "op");
    const second = toGuestFacingMessage(foreignKeyViolation(), "op");

    // Two faults, two records, two ids: a reused id would make the reference
    // useless for finding *this* guest's failure.
    expect(referenceIn(first)).not.toBe(referenceIn(second));
    expect(consoleSpies.error).toHaveBeenCalledTimes(2);
  });

  it("is returned by logUnexpectedFailure and appears in that record", () => {
    const reference = logUnexpectedFailure(
      foreignKeyViolation(),
      "createBookingAction",
    );

    const { summary, payload } = soleLogRecord();
    expect(reference).toMatch(UUID_PATTERN);
    expect(summary).toContain(reference);
    expect(summary).toContain("createBookingAction");
    expect(payload.reference).toBe(reference);
  });
});

describe("genericFailureMessage", () => {
  it("carries the reference and nothing about the failure", () => {
    const reference = "9f8e7d6c-5b4a-4321-8765-0123456789ab";

    const message = genericFailureMessage(reference);

    expect(message).toContain(reference);
    expect(expectNoLeak(message)).toBe(reference);
  });

  it("is the same sentence whatever the fault, so it is not an oracle", () => {
    const a = toGuestFacingMessage(foreignKeyViolation(), "op");
    const b = toGuestFacingMessage(misconfiguration(), "op");

    // Only the reference differs — a guest cannot tell a missing env var from a
    // constraint violation from a dropped connection.
    expect(a.replace(UUID_PATTERN, "<ref>")).toBe(b.replace(UUID_PATTERN, "<ref>"));
  });
});
