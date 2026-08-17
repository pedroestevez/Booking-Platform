import "server-only";

/**
 * What a public, unauthenticated caller is allowed to be told when something
 * fails (ALI-140).
 *
 * ## The hole this closes
 *
 * `createBookingAction` used to answer a failed booking with `err.message`,
 * whatever that message was. `PostgrestError extends Error`, so every fault the
 * write path could hit reached an anonymous visitor as raw driver text:
 * constraint names (`end_customers_customer_id_email_key`), RLS denials naming
 * tables, and — on misconfiguration — `createServiceRoleClient`'s own message
 * naming `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Nothing was
 * logged, so the attacker saw the fault and the operator did not: the error
 * report went to exactly the wrong party.
 *
 * The scope is wider than the driver (ALI-167 security pass, S2). A server-side
 * `raise exception` in a migration is *our* text, and it interpolates: 0007's
 * 40001 message puts `p_customer_id` and the guest's email into itself, and
 * arrives here as a `PostgrestError` like any other. So the rule cannot be "sift
 * the driver's wording" — it has to be an **allowlist**: a message reaches a
 * guest only if this codebase wrote it for a guest, and everything else is
 * replaced.
 *
 * ## Why the allowlist is by message, and not a marker class
 *
 * The obvious alternative is a `GuestFacingError` subclass thrown at each
 * intentional refusal. It was tried and rejected, for one concrete reason: it
 * changes the 23P01 path, which ALI-140's criterion requires to be unchanged.
 * `bookings.conflict.test.ts` pins that path with
 * `rejects.toThrow(new Error(CONFLICT_MESSAGE))`, and Vitest compares the error
 * *class* as well as the message — so marking the throw site turns an ALI-98
 * assertion red and forces an edit to the one path that was already safe. The
 * classification therefore lives entirely here, at the boundary, and
 * `src/lib/bookings.ts` is untouched by this issue.
 *
 * The trade this makes, stated plainly: the set below is a copy of three string
 * literals, so if one of those sentences is reworded and this set is not, the
 * guest gets the generic message instead of good copy. That failure is **safe**
 * (a leak is impossible in that direction) and it is **caught**: every sentence
 * in the set is pinned at the action level by an existing suite — the conflict
 * message by `bookings.conflict.test.ts`, the service message and the unknown-
 * tenant message by `booking-tenant-scope.test.ts` — so a reword without an
 * update here goes red rather than silently degrading.
 *
 * ## The correlation id is the point of the generic message
 *
 * A generic message on its own turns every fault into "something went wrong" for
 * both parties. The reference in it is also in the log record, so a guest can
 * quote six words and an operator can find the one stack trace that produced
 * them. That is the whole trade: the guest loses the detail, the operator gains
 * it.
 */

/**
 * Every message this codebase writes **for a guest to read**.
 *
 * These are constants in the source, they name nothing about the machinery, and
 * they are load-bearing product copy — ALI-98 depends on the availability
 * pre-check and the `bookings_no_overlap` constraint producing the *same*
 * sentence, so that a guest cannot tell which layer refused them. Anything not
 * in this set is treated as unexpected, which is what makes the default closed:
 * a new `throw new Error("…")` anywhere on the booking path is generic to the
 * guest and legible in the log, and the cost of forgetting to add a sentence
 * here is terse copy, never a disclosure.
 *
 * Keep the provenance comments. The set is only trustworthy while each entry
 * can be traced to the line that throws it.
 */
export const GUEST_FACING_MESSAGES: ReadonlySet<string> = new Set([
  // src/lib/bookings.ts — the availability pre-check, and the 23P01 loser of a
  // real race. Deliberately the same sentence from both (ALI-98).
  "Sorry, that time was just taken. Please pick another.",
  // src/lib/bookings.ts — the service was deleted or deactivated mid-flow.
  "That service is no longer available.",
  // src/app/[customerSlug]/actions.ts — the slug resolves to no tenant. Returned
  // directly rather than thrown today; listed so it keeps working if that ever
  // becomes a `throw`, and so this set is the whole inventory rather than most
  // of it.
  "This booking page is no longer available.",
]);

/**
 * The generic answer, carrying the correlation id.
 *
 * Deliberately says nothing about the failure. It names no table, column,
 * constraint, SQLSTATE, environment variable or service — and the reference is a
 * random v4 UUID, which encodes nothing about the fault either. Two different
 * faults produce the same sentence, so this is not an oracle. The one useful
 * thing a guest can do with it is quote it, so the copy asks them to.
 */
export function genericFailureMessage(reference: string): string {
  return (
    "Something went wrong creating your booking. Please try again — if it " +
    `keeps happening, quote reference ${reference} when you get in touch.`
  );
}

/** A shape that survives `JSON.stringify` into a log line. */
type Described = Record<string, unknown>;

/** `String(value)`, for a value that may refuse to be one. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unstringifiable value>";
  }
}

/**
 * Everything an operator needs about a thrown value, in one object.
 *
 * `message` alone is not enough. PostgREST reports the SQLSTATE in `code` and
 * the interesting half of a constraint violation in `details` (the key values —
 * which is also why `details` must never reach a browser), and both sit on the
 * error object rather than inside its message. A wrapped `fetch` failure hides
 * the real reason (`ECONNREFUSED`) in `cause` and says only "fetch failed" at
 * the top level, so one level of `cause` is unwrapped too — one, because a cause
 * chain can be long and a log line should not be.
 */
function describeError(err: unknown, depth = 0): Described {
  if (!(err instanceof Error)) {
    // A thrown string, object, or `undefined`. Rare, and exactly the case where
    // the old code fell through to a message with no detail at all.
    return { thrown: typeof err, value: safeString(err) };
  }

  const described: Described = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };

  // PostgrestError and pg carry these; a plain Error does not.
  for (const key of ["code", "details", "hint"] as const) {
    const value = (err as unknown as Described)[key];
    if (value !== undefined) described[key] = value;
  }

  if (err.cause !== undefined && depth < 1) {
    described.cause = describeError(err.cause, depth + 1);
  }

  return described;
}

/**
 * Log an unexpected failure — **once** — and return its correlation id.
 *
 * One `console.error` call, one record. Not two: a summary line plus a detail
 * line splits the id from the stack across two entries and doubles the noise.
 * The record carries the original error verbatim, on purpose — the browser gets
 * the generic message *because* the detail goes here instead.
 */
export function logUnexpectedFailure(err: unknown, operation: string): string {
  // The global Web Crypto `randomUUID`, not `node:crypto`'s: identical CSPRNG,
  // available in both the Node and Edge runtimes, so this module stays
  // importable wherever a server action ends up running.
  const reference = crypto.randomUUID();

  console.error(`[${operation}] unexpected failure (ref ${reference})`, {
    reference,
    operation,
    error: describeError(err),
  });

  return reference;
}

/**
 * The boundary rule, as one call: what may this thrown value tell the caller?
 *
 * Use it in the `catch` of every server action reachable without
 * authentication. A message written for a guest passes through unchanged;
 * everything else is logged once and answered generically.
 *
 * @param operation identifies the call site in the log (e.g. the action name).
 */
export function toGuestFacingMessage(err: unknown, operation: string): string {
  if (err instanceof Error && GUEST_FACING_MESSAGES.has(err.message)) {
    return err.message;
  }
  return genericFailureMessage(logUnexpectedFailure(err, operation));
}
