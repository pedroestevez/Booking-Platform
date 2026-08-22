import type { ErrorResponse } from "resend";

import type {
  ResendLike,
  ResendSendPayload,
} from "@/lib/email/provider";

/**
 * A faithful fake of Resend's send API (ALI-155, `docs/ENGINE.md` §6).
 *
 * A fake that only says yes is a model of success, not of the system. This one
 * encodes the rejections the real Resend makes, so a test that passes against
 * it is evidence about production rather than evidence about the fake.
 *
 * ## Two things pin it to the real vendor
 *
 * 1. **Shape.** Resend's `emails.send()` resolves `{ data, error }` and does
 *    **not** throw on an API rejection — it throws only on a transport fault.
 *    A fake that threw a 422 would let a caller that handles exceptions look
 *    correct while dropping every real 422 on the floor. This one resolves.
 * 2. **Vocabulary.** Every rejection below is typed `ErrorResponse`, the type
 *    exported by the installed `resend` package, whose `name` is the SDK's own
 *    closed union of error codes. An invented code does not compile — so the
 *    fake cannot drift into a vocabulary the vendor does not speak, and a
 *    version bump that renames a code turns this file red instead of leaving a
 *    green suite modelling a vendor that no longer exists.
 *
 * ## The rejections encoded
 *
 * | Input | Real Resend | Here |
 * | -- | -- | -- |
 * | no API key | 401 `missing_api_key` | same |
 * | missing `from` | 422 `missing_required_field` | same |
 * | `from` on an unverified domain | 403 `invalid_from_address` | same |
 * | malformed `to` | 422 `validation_error` | same |
 * | missing `subject` | 422 `missing_required_field` | same |
 * | no `text` and no `html` | 422 `missing_required_field` | same |
 * | transport failure | resolves `application_error`, null status | same |
 *
 * And one thing the vendor does that is not a rejection at all: **it can fail
 * to answer.** `stallFor`/`delayFor` model that. Every rejection above is
 * instant, and against an instant-only fake a provider with no timeout is
 * indistinguishable from one with a timeout — which is exactly how an unbounded
 * send survived a green suite (ALI-196 B1).
 *
 * Anything accepted is recorded in `sent`, in order, exactly as it was passed —
 * which is what lets a test decode the attachment the vendor would have
 * received rather than assert that *an* attachment was passed.
 */

/** A canned rejection, in the vendor's own vocabulary. */
export const RESEND_REJECTIONS = {
  /** An invalid or revoked key. */
  unauthorized: {
    message: "API key is invalid",
    name: "invalid_api_key",
    statusCode: 401,
  },
  /** The message was addressed or shaped in a way the API refuses. */
  validation: {
    message: "Invalid `to` field. The email address needs to be a valid email.",
    name: "validation_error",
    statusCode: 422,
  },
  /** Too many requests. */
  rateLimited: {
    message: "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  /**
   * The network failed and the SDK swallowed it.
   *
   * Modelled because the port's `catch` around `emails.send()` implies the SDK
   * throws on a transport fault, and it does not: `fetchRequest` wraps the
   * whole call and *resolves* `application_error` with a null status
   * [verified in resend@6.20.0's bundle]. Tests that only ever drove a throwing
   * client were exercising a branch production cannot reach (ALI-196 rider 6).
   */
  transportFailed: {
    message: "Unable to fetch data. The request could not be resolved.",
    name: "application_error",
    statusCode: null,
  },
} as const satisfies Record<string, ErrorResponse>;

/**
 * Whether an address is one Resend will accept.
 *
 * Deliberately permissive about the local part and strict about the parts the
 * vendor is strict about: exactly one `@`, a non-empty local part, a dotted
 * domain, and no whitespace or angle brackets anywhere.
 */
export function isDeliverableAddress(address: string): boolean {
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;.]+$/.test(address.trim());
}

/**
 * The bare address out of `Name <a@b.c>` or `a@b.c`.
 *
 * Quoted display names are removed before the scan, because angle brackets
 * inside one are part of the name and not the address. `formatFrom` emits
 * `"Evil <a@evil.com> Co" <bookings@example.test>` for a tenant named
 * `Evil <a@evil.com> Co`, and taking the first `<...>` read that as a send from
 * `evil.com` — an unverified domain — so the fake refused, with zero sends, a
 * message real Resend accepts. A fake that rejects what the vendor allows fails
 * a test for a bug that does not exist, which costs exactly as much trust as
 * the opposite (ALI-196 rider 6).
 */
function addressOf(value: string): string {
  const unquoted = value.replace(/"(?:\\.|[^"\\])*"/g, "");
  const angled = /<([^>]*)>/.exec(unquoted);
  return (angled ? angled[1]! : value).trim();
}

export interface FakeResendOptions {
  /** Unset or empty models a client constructed without a key. */
  apiKey?: string | null;
  /** Domains verified in the Resend account. Sending from any other is refused. */
  verifiedDomains?: string[];
}

export class FakeResend implements ResendLike {
  /** Every payload the vendor accepted, in order. */
  readonly sent: ResendSendPayload[] = [];

  private readonly apiKey: string | null;
  private readonly verifiedDomains: string[];
  /** Per-recipient rejections, keyed by lowercased bare address. */
  private readonly rejections = new Map<string, ErrorResponse>();
  /** Recipients whose send never settles, keyed the same way. */
  private readonly stalls = new Set<string>();
  /** Recipients whose send is slow but does answer, in ms. */
  private readonly delays = new Map<string, number>();

  constructor(options: FakeResendOptions = {}) {
    this.apiKey = options.apiKey === undefined ? "re_test_key" : options.apiKey;
    this.verifiedDomains = options.verifiedDomains ?? ["example.test"];
  }

  /**
   * Make the vendor refuse the message addressed to `address`.
   *
   * Per-recipient rather than global on purpose: it is what lets a test prove
   * that one refused send costs only itself, which a blanket failure switch
   * cannot show.
   */
  rejectFor(address: string, error: ErrorResponse): void {
    this.rejections.set(addressOf(address).toLowerCase(), error);
  }

  /**
   * Make the send to `address` never settle — the latency clause (ALI-196).
   *
   * The gap this closes: every rejection the fake could produce was an
   * *instant* answer (401, 403, 422, 429). A provider with no timeout looks
   * identical to one with a timeout when every answer is immediate, so the
   * whole hang class was invisible to a green suite. This is the input that
   * tells them apart.
   */
  stallFor(address: string): void {
    this.stalls.add(addressOf(address).toLowerCase());
  }

  /** Make the send to `address` take `ms` before answering normally. */
  delayFor(address: string, ms: number): void {
    this.delays.set(addressOf(address).toLowerCase(), ms);
  }

  /** Every address the vendor accepted a message for. */
  recipients(): string[] {
    return this.sent.map((payload) => addressOf(payload.to));
  }

  readonly emails = {
    send: async (
      payload: ResendSendPayload,
    ): Promise<{ data: { id: string } | null; error: ErrorResponse | null }> => {
      const recipient = addressOf(payload.to ?? "").toLowerCase();

      // Before every validation below, because a request that stalls on the
      // wire is never answered at all — not answered with a 403.
      if (this.stalls.has(recipient)) {
        return new Promise<never>(() => {});
      }
      const delay = this.delays.get(recipient);
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (!this.apiKey) {
        return {
          data: null,
          error: {
            message: "Missing API key in the authorization header",
            name: "missing_api_key",
            statusCode: 401,
          },
        };
      }

      const from = addressOf(payload.from ?? "");
      if (!from) {
        return {
          data: null,
          error: {
            message: "Missing `from` field",
            name: "missing_required_field",
            statusCode: 422,
          },
        };
      }

      const domain = from.split("@")[1]?.toLowerCase();
      if (!domain || !this.verifiedDomains.includes(domain)) {
        // The rejection that makes an unconfigured deploy fail closed rather
        // than appear to work: Resend refuses any `from` whose domain is not
        // verified in the account.
        return {
          data: null,
          error: {
            message: `The ${domain ?? "(none)"} domain is not verified. Please verify your domain on resend.com/domains`,
            name: "invalid_from_address",
            statusCode: 403,
          },
        };
      }

      const to = addressOf(payload.to ?? "");
      if (!isDeliverableAddress(to)) {
        return { data: null, error: { ...RESEND_REJECTIONS.validation } };
      }

      if (!payload.subject) {
        return {
          data: null,
          error: {
            message: "Missing `subject` field",
            name: "missing_required_field",
            statusCode: 422,
          },
        };
      }

      if (!payload.text && !payload.html) {
        return {
          data: null,
          error: {
            message: "Missing `html`, `text` or `react` field",
            name: "missing_required_field",
            statusCode: 422,
          },
        };
      }

      const injected = this.rejections.get(to.toLowerCase());
      if (injected) return { data: null, error: { ...injected } };

      this.sent.push(payload);
      return {
        data: { id: `fake-email-${this.sent.length}` },
        error: null,
      };
    },
  };
}
