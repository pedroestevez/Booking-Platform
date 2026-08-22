import "server-only";

import { Resend } from "resend";

/**
 * The email port — one narrow interface over Resend (ALI-69).
 *
 * Everything above this module talks in `EmailMessage` and never imports the
 * vendor SDK. Two reasons, and neither is taste:
 *
 *   • **One failure channel.** Resend's `emails.send()` does *not* throw on an
 *     API rejection — it resolves `{ data: null, error: { message, name,
 *     statusCode } }`, and throws only on a transport fault. A caller that
 *     handles one of those two shapes and forgets the other has a `catch` block
 *     that looks like error handling and silently drops 401s. `send()` below
 *     collapses both into a single rule: it resolves when the vendor accepted
 *     the message, and throws `EmailSendError` otherwise.
 *   • **One recipient per call.** `to` is a single address, not an array, so
 *     "two separate sends, so neither party's address is disclosed to the
 *     other" is enforced by the type rather than by remembering.
 *
 * ## Lazy and loud (ALI-155)
 *
 * Constructed on first use, never at import, exactly as `getStripe()` does at
 * `src/lib/stripe/server.ts` — so `next build` stays green with no key present.
 * Unkeyed it throws `EmailNotConfiguredError`; it never returns a stub that
 * reports success for a message nobody sent.
 */

/** Thrown when the vendor is not configured at all — never a silent no-op. */
export class EmailNotConfiguredError extends Error {
  readonly name = "EmailNotConfiguredError";

  constructor(missing: string) {
    super(
      `Email is not configured: set ${missing} in the environment ` +
        "(see .env.example).",
    );
  }
}

/** Thrown when the vendor was reachable-or-not and refused to accept the message. */
export class EmailSendError extends Error {
  // Typed `string` rather than the literal so `EmailTimeoutError` can narrow it
  // to its own name; nothing branches on the literal type.
  readonly name: string = "EmailSendError";

  constructor(
    message: string,
    /** The vendor's HTTP status, when it gave one. */
    readonly statusCode: number | null,
    /** The vendor's machine-readable code, e.g. `validation_error`. */
    readonly vendorCode: string | null,
  ) {
    super(message);
  }
}

/**
 * How long a single vendor call may take before the caller is freed (ALI-196).
 *
 * Ten seconds is well past Resend's normal response and well inside any
 * reasonable patience for someone who has just pressed "Book". The number that
 * matters is not this one but the fact that *some* finite number applies:
 * before this, the only ceiling was undici's 300s default, per send.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * Thrown when a send exceeded its bound (ALI-196 B1).
 *
 * An `EmailSendError` subclass on purpose: every existing caller already treats
 * that as "this send did not happen", which is exactly the right reading, and
 * the failure logger's shape needs no special case. `vendorCode` is `timeout`
 * so a timed-out send is distinguishable in the log from a vendor rejection.
 */
export class EmailTimeoutError extends EmailSendError {
  readonly name = "EmailTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(
      `Email send exceeded ${timeoutMs}ms and was abandoned. The booking it ` +
        "refers to is unaffected.",
      null,
      "timeout",
    );
  }
}

/** A file attached to an outgoing message. */
export interface EmailAttachment {
  filename: string;
  /** Base64-encoded bytes. */
  contentBase64: string;
  /** MIME type, e.g. `text/calendar`. */
  contentType: string;
}

/** One message to one recipient. */
export interface EmailMessage {
  /** Exactly one address. See "one recipient per call" above. */
  to: string;
  /**
   * The display name shown before the configured sender address. Tenant-
   * controlled data — sanitized by `formatFrom` before it reaches a header.
   */
  fromName: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

/** What the rest of the app depends on. Implemented over Resend below. */
export interface EmailProvider {
  /** Resolves when the vendor accepted the message; throws `EmailSendError`. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

/**
 * The slice of the Resend SDK this app uses.
 *
 * Declared structurally rather than imported as `Resend` so the faithful fake
 * (`src/test/fake-resend.ts`) can be checked against the same shape the real
 * client is checked against — a fake that satisfies a hand-written interface
 * nobody holds the vendor to is a fake of nothing.
 */
export interface ResendErrorLike {
  message: string;
  name: string;
  statusCode: number | null;
}

export interface ResendSendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
}

export interface ResendLike {
  emails: {
    send(payload: ResendSendPayload): Promise<{
      data: { id: string } | null;
      error: ResendErrorLike | null;
    }>;
  };
}

/**
 * Control characters removed from any single-line header value (ALI-196).
 *
 * `From` was hardened at ALI-69 and `Subject` was not, though both are headers
 * and both carry tenant-controlled text — the service name and the tenant name
 * reach `Subject` verbatim. A CR or LF there ends the header and begins one of
 * the sender's choosing, which is the same injection `formatFrom` exists to
 * stop, one header over. Applied at the port so it covers every caller rather
 * than every caller who remembers.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/**
 * Everything except an address is stripped from a display name before it is
 * put in a `From` header.
 *
 * `fromName` is the tenant's own `customers.name` — tenant-controlled text on
 * its way into an SMTP header, which is the classic header-injection position:
 * a CR or LF in it ends the `From` line and starts a header of the attacker's
 * choosing (`Bcc:`, a forged `Reply-To`). Control characters are removed, the
 * two characters that can escape a quoted string are escaped, and the result is
 * always quoted — so the worst a hostile name can do is look odd.
 */
export function formatFrom(displayName: string, address: string): string {
  const safeName = sanitizeHeaderValue(displayName)
    .replace(/["\\]/g, "\\$&")
    .trim();
  return safeName ? `"${safeName}" <${address}>` : address;
}

/**
 * The bare address out of `RESEND_FROM`, which may be configured either way.
 *
 * The display name is per-send (it is the tenant's name), so a name configured
 * in the env var is dropped rather than concatenated into a second one.
 */
export function senderAddress(configured: string): string {
  const angled = /<([^>]+)>/.exec(configured);
  return (angled ? angled[1]! : configured).trim();
}

/**
 * Bound a vendor call in wall-clock time (ALI-196 B1).
 *
 * A race and not an `AbortSignal` because there is nothing to signal:
 * resend@6.20.0 passes no `signal` to `fetch` anywhere in its bundle
 * [verified: zero occurrences of `signal` in `dist/index.mjs`], so the
 * in-flight request cannot be cancelled — only abandoned. The socket is left
 * to the runtime; what this guarantees is that the *caller* is freed on time,
 * which is the half a guest waiting on a server action can feel.
 *
 * The abandoned promise gets a terminal handler before the race, because a
 * rejection arriving after the race is lost would otherwise be an unhandled
 * rejection — a fix for a hang that crashes the process instead is not a fix.
 */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  operation.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new EmailTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // Without this the timer holds the event loop open for the full bound on
    // every successful send, which turns a fast suite into a slow one.
    clearTimeout(timer);
  }
}

/** Build a provider over any Resend-shaped client. The unit under test. */
export function createResendProvider(
  client: ResendLike,
  fromAddress: string,
  timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
): EmailProvider {
  return {
    async send(message) {
      let result: Awaited<ReturnType<ResendLike["emails"]["send"]>>;
      try {
        result = await withTimeout(
          client.emails.send({
            from: formatFrom(message.fromName, fromAddress),
            to: message.to,
            subject: sanitizeHeaderValue(message.subject),
            text: message.text,
            html: message.html,
            attachments: message.attachments?.map((a) => ({
              filename: a.filename,
              content: a.contentBase64,
              contentType: a.contentType,
            })),
          }),
          timeoutMs,
        );
      } catch (cause) {
        // Already in this module's vocabulary, and its own distinct reason.
        if (cause instanceof EmailTimeoutError) throw cause;
        // A synchronous throw or a rejected send. The real SDK reaches neither
        // — its `fetchRequest` catches every fetch rejection and resolves
        // `application_error` / `statusCode: null` [verified in
        // resend@6.20.0's bundle] — but the port is defined over `ResendLike`,
        // not over one vendor build, so the channel stays closed.
        throw new EmailSendError(
          cause instanceof Error ? cause.message : String(cause),
          null,
          "transport_error",
        );
      }

      if (result.error) {
        throw new EmailSendError(
          result.error.message,
          result.error.statusCode ?? null,
          result.error.name ?? null,
        );
      }
      if (!result.data) {
        // Neither accepted nor refused. Treated as a failure: reporting success
        // for a message with no id is the one answer that cannot be true.
        throw new EmailSendError(
          "Vendor returned neither an id nor an error.",
          null,
          "empty_response",
        );
      }
      return { id: result.data.id };
    },
  };
}

let cached: EmailProvider | null = null;

/**
 * The configured provider, or a loud refusal.
 *
 * Both variables are required: a key with no `RESEND_FROM` cannot address a
 * message, and treating that as "configured" would trade a legible startup
 * failure for a vendor 422 at the moment a real guest is waiting.
 */
export function getEmailProvider(): EmailProvider {
  if (cached) return cached;

  const key = process.env.RESEND_API_KEY;
  if (!key) throw new EmailNotConfiguredError("RESEND_API_KEY");

  const from = process.env.RESEND_FROM;
  if (!from) throw new EmailNotConfiguredError("RESEND_FROM");

  cached = createResendProvider(
    new Resend(key) as unknown as ResendLike,
    senderAddress(from),
  );
  return cached;
}

/** Whether email is configured at all — lets a caller degrade deliberately. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}
