import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailNotConfiguredError,
  EmailSendError,
  createResendProvider,
  formatFrom,
  getEmailProvider,
  isEmailConfigured,
  senderAddress,
  type ResendLike,
} from "@/lib/email/provider";
import {
  FakeResend,
  RESEND_REJECTIONS,
  isDeliverableAddress,
} from "@/test/fake-resend";

/**
 * The port over Resend, and the proof that the fake it is tested against is
 * faithful (ALI-69 AC4/AC6, ALI-155).
 *
 * The suite that matters most here is "the fake refuses what Resend refuses".
 * Every other assertion in this issue's tests is only as good as that one: a
 * permissive fake would make the entire email suite a model of a vendor that
 * accepts anything, and the first real send would be the first real test.
 */

const FROM = "bookings@example.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── The fake is faithful (ALI-155) ───────────────────────────────────────────
describe("the Resend fake refuses what the real Resend refuses", () => {
  const good = {
    from: `"Tenant" <${FROM}>`,
    to: "guest@example.com",
    subject: "Your booking is confirmed",
    text: "body",
    html: "<p>body</p>",
  };

  it("accepts a well-formed message, so the refusals below mean something", async () => {
    const resend = new FakeResend();
    const { data, error } = await resend.emails.send(good);

    expect(error).toBeNull();
    expect(data?.id).toEqual(expect.any(String));
    expect(resend.sent).toHaveLength(1);
  });

  // The load-bearing one. A `from` whose domain is not verified in the Resend
  // account is refused with 403 `invalid_from_address` — which is exactly the
  // state this product is in until the sender domain is verified (ALI-177 P2),
  // so a fake that accepted it would report a deploy as working that cannot
  // deliver a single message.
  it("refuses a from address on an unverified domain (403)", async () => {
    const resend = new FakeResend({ verifiedDomains: ["example.test"] });
    const { data, error } = await resend.emails.send({
      ...good,
      from: "someone@not-verified.example",
    });

    expect(data).toBeNull();
    expect(error?.statusCode).toBe(403);
    expect(error?.name).toBe("invalid_from_address");
    expect(resend.sent).toHaveLength(0);
  });

  it("refuses a missing from (422)", async () => {
    const resend = new FakeResend();
    const { data, error } = await resend.emails.send({ ...good, from: "" });

    expect(data).toBeNull();
    expect(error?.statusCode).toBe(422);
    expect(error?.name).toBe("missing_required_field");
    expect(resend.sent).toHaveLength(0);
  });

  it.each([
    ["not-an-email", "not-an-email"],
    ["no domain dot", "guest@example"],
    ["empty", ""],
    ["two addresses in one field", "a@example.com,b@example.com"],
    ["a space", "guest name@example.com"],
  ])("refuses a malformed recipient — %s (422)", async (_label, to) => {
    const resend = new FakeResend();
    const { data, error } = await resend.emails.send({ ...good, to });

    expect(data).toBeNull();
    expect(error?.statusCode).toBe(422);
    expect(error?.name).toBe("validation_error");
    expect(resend.sent).toHaveLength(0);
  });

  it("refuses a missing subject (422)", async () => {
    const resend = new FakeResend();
    const { data, error } = await resend.emails.send({ ...good, subject: "" });

    expect(data).toBeNull();
    expect(error?.statusCode).toBe(422);
    expect(error?.name).toBe("missing_required_field");
    expect(resend.sent).toHaveLength(0);
  });

  it("refuses a message with no body at all (422)", async () => {
    const resend = new FakeResend();
    const { data, error } = await resend.emails.send({
      ...good,
      text: "",
      html: "",
    });

    expect(data).toBeNull();
    expect(error?.name).toBe("missing_required_field");
    expect(resend.sent).toHaveLength(0);
  });

  it("refuses everything when the client has no API key (401)", async () => {
    const resend = new FakeResend({ apiKey: null });
    const { data, error } = await resend.emails.send(good);

    expect(data).toBeNull();
    expect(error?.statusCode).toBe(401);
    expect(error?.name).toBe("missing_api_key");
    expect(resend.sent).toHaveLength(0);
  });

  // Resend reports API rejections in the resolved value, and throws only on a
  // transport fault. A fake that threw would let a caller that only handles
  // exceptions look correct while dropping every real rejection.
  it("resolves its rejections rather than throwing them", async () => {
    const resend = new FakeResend({ apiKey: null });
    await expect(resend.emails.send(good)).resolves.toMatchObject({
      data: null,
    });
  });

  it("accepts the address shapes Resend accepts", () => {
    expect(isDeliverableAddress("guest@example.com")).toBe(true);
    expect(isDeliverableAddress("guest+tag@sub.example.co.uk")).toBe(true);
    expect(isDeliverableAddress("guest@example")).toBe(false);
  });
});

// ── The port collapses both vendor failure shapes into one (AC4) ─────────────
describe("createResendProvider", () => {
  const message = {
    to: "guest@example.com",
    fromName: "Tenant One",
    subject: "Confirmed",
    text: "body",
    html: "<p>body</p>",
  };

  it("resolves with the vendor's id when the message is accepted", async () => {
    const resend = new FakeResend();
    const provider = createResendProvider(resend, FROM);

    await expect(provider.send(message)).resolves.toEqual({
      id: expect.any(String),
    });
    expect(resend.sent[0]!.to).toBe("guest@example.com");
  });

  it.each([
    ["401 unauthorized", RESEND_REJECTIONS.unauthorized, 401],
    ["422 validation", RESEND_REJECTIONS.validation, 422],
    ["429 rate limited", RESEND_REJECTIONS.rateLimited, 429],
  ])("turns a %s rejection into EmailSendError", async (_label, rejection, status) => {
    const resend = new FakeResend();
    resend.rejectFor(message.to, rejection);
    const provider = createResendProvider(resend, FROM);

    const err = await provider.send(message).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).statusCode).toBe(status);
    expect((err as EmailSendError).vendorCode).toBe(rejection.name);
    expect(resend.sent).toHaveLength(0);
  });

  it("turns a transport fault into the same EmailSendError", async () => {
    const throwing: ResendLike = {
      emails: {
        send: async () => {
          throw new Error("fetch failed");
        },
      },
    };

    const err = await createResendProvider(throwing, FROM)
      .send(message)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).vendorCode).toBe("transport_error");
  });

  // Neither an id nor an error is the one answer that cannot be true. Reporting
  // success for it would record a send nobody made.
  it("refuses to call an empty response a success", async () => {
    const empty: ResendLike = {
      emails: { send: async () => ({ data: null, error: null }) },
    };

    await expect(
      createResendProvider(empty, FROM).send(message),
    ).rejects.toBeInstanceOf(EmailSendError);
  });

  it("sends the attachment through as base64 with its content type", async () => {
    const resend = new FakeResend();
    await createResendProvider(resend, FROM).send({
      ...message,
      attachments: [
        {
          filename: "invite.ics",
          contentBase64: Buffer.from("BEGIN:VCALENDAR").toString("base64"),
          contentType: "text/calendar",
        },
      ],
    });

    const [attachment] = resend.sent[0]!.attachments!;
    expect(attachment!.filename).toBe("invite.ics");
    expect(attachment!.contentType).toBe("text/calendar");
    expect(Buffer.from(attachment!.content, "base64").toString("utf8")).toBe(
      "BEGIN:VCALENDAR",
    );
  });
});

// ── The From header is built from tenant-controlled text ─────────────────────
describe("formatFrom", () => {
  it("shows the tenant's name in front of the configured address", () => {
    expect(formatFrom("Northwind Therapy", FROM)).toBe(
      `"Northwind Therapy" <${FROM}>`,
    );
  });

  // Header injection: `customers.name` is tenant-controlled and lands in an SMTP
  // header. A CR or LF in it would end the `From` line and start a header of the
  // author's choosing.
  it.each([
    ["a newline", "Evil\nBcc: victim@example.com"],
    ["a CRLF", "Evil\r\nBcc: victim@example.com"],
    ["a bare CR", "Evil\rBcc: victim@example.com"],
    ["a null byte", "Evil\u0000Bcc: victim@example.com"],
  ])("strips %s from the display name", (_label, hostile) => {
    const header = formatFrom(hostile, FROM);

    // Nothing survives that could terminate a header line, so the hostile text
    // can only ever be part of the display name — never a header of its own.
    expect(header).not.toMatch(/[\r\n\u0000]/);
    expect(header).toMatch(
      /^"Evil\s+Bcc: victim@example\.com" <bookings@example\.test>$/,
    );
  });

  it("escapes the characters that would close the quoted name early", () => {
    expect(formatFrom('Ev"il\\', FROM)).toBe(`"Ev\\"il\\\\" <${FROM}>`);
  });

  it("falls back to the bare address when the name is empty", () => {
    expect(formatFrom("   ", FROM)).toBe(FROM);
  });
});

describe("senderAddress", () => {
  it("takes the bare address either way it is configured", () => {
    expect(senderAddress(FROM)).toBe(FROM);
    expect(senderAddress(`AlignCompass <${FROM}>`)).toBe(FROM);
  });
});

// ── AC6: unconfigured is loud, never a silent success ────────────────────────
describe("getEmailProvider without a key", () => {
  it("throws a distinctly-named error rather than pretending to send", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM", "");

    expect(() => getEmailProvider()).toThrow(EmailNotConfiguredError);
    expect(isEmailConfigured()).toBe(false);
  });

  it("names the variable to set, and never a value", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM", FROM);

    expect(() => getEmailProvider()).toThrow(/RESEND_API_KEY/);
  });

  // A key with nowhere to send from is not configured either — treating it as
  // configured trades a legible failure for a vendor 422 with a guest waiting.
  it("is not satisfied by a key alone", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("RESEND_FROM", "");

    expect(() => getEmailProvider()).toThrow(/RESEND_FROM/);
    expect(isEmailConfigured()).toBe(false);
  });
});
