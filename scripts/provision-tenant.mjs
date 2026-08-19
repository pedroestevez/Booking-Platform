#!/usr/bin/env node
// scripts/provision-tenant.mjs — ALI-176
//
// Provisions ONE tenant (a `customers` row plus its `services` and
// `availability_rules`) against the database named by the environment variable
// `PROVISION_DATABASE_URL`. Every value is input, not a constant: the built-in
// defaults are ALI-177's P4 draft, and each of them is overridable from a JSON
// spec file or a command-line flag.
//
// ── Why this is not `scripts/seed-test-tenant.mjs` ───────────────────────────
// The e2e seeder converges by `delete from services` / `delete from
// availability_rules` before re-inserting. Against a throwaway CI database that
// is fine. Against a real tenant it is data loss: `bookings.service_id` is
// `on delete restrict`, so either the delete fails outright once a single
// booking exists, or — for a service nobody has booked yet — the catalogue row
// silently changes identity and every future reference to it is a new row.
//
// This script therefore **never deletes anything**. Convergence is per-row
// upsert:
//
//   • `customers`      — matched by its unique `slug`.
//   • `services`       — matched by `(customer_id, name)`. Present → update
//                        description/duration/price/active. Absent → insert.
//   • `availability_rules` — matched by `(customer_id, day_of_week, start_time,
//                        end_time)`. Present → update `buffer_minutes`.
//                        Absent → insert.
//
// Rows that exist in the database but are absent from the spec are **reported
// and left alone**. Removing a service or an open-hours window is a deliberate
// act on live data and is not something a provisioning run should infer from an
// omission.
//
// ── The defaults are a CREATE template, never an UPDATE instruction (S1) ─────
// The security pass on the first round found the sharp edge here, and it is
// worth stating plainly because it is counter-intuitive. Merging
// `branding_json` with `||` preserves keys the *spec* omits — but the P4 draft
// sits at the floor of the precedence chain, so `brandColor`, `currency`,
// `timezone` and `name` were never absent from a spec. Every re-run rewrote
// them. An owner who fixed their timezone in `/admin`, or a P4 draft value that
// was wrong to begin with, was silently reset by the next `--service` run:
// every slot on the public page and every already-`confirmed` booking shifted,
// exit 0, no warning.
//
// So this script tracks **provenance**, not just values:
//
//   • CREATE — the draft fills whatever the invocation did not supply. That is
//     what "defaults to the P4 draft" means, and on a row that does not exist
//     yet there is nothing to destroy.
//   • UPDATE — only what THIS invocation explicitly supplied is written.
//     `name` is left alone unless `--name`/`spec.name` was given; a
//     `branding_json` key is left byte-identical unless that key was given;
//     `services`/`availability_rules` are not touched at all unless
//     `--service`/`--rule` (or the spec's arrays) were given.
//
// The invariant this serves is the issue's: *no provisioning run ever destroys
// tenant-owned data.* A timezone an owner set is tenant-owned data, and row
// survival is not the whole of it — a converging writer has to be judged on
// every column it writes.
//
// ── Refusing to write by accident ───────────────────────────────────────────
//   • `PROVISION_DATABASE_URL` must be set AND must name both a host and a
//     database. A degenerate value like `postgres://` is truthy, and
//     node-postgres would then fill the host/user/database from ambient
//     `PGHOST`/`PGUSER`/`PGDATABASE` — a fallback by another name, which is
//     exactly what this variable exists to prevent (S2). After connecting, the
//     run also checks `current_database()` against the name the variable gave
//     and aborts on any mismatch, before writing anything.
//   • The connection string is **never printed** (S3). `redact()` covered
//     `user:pass@host` but not the equally valid `?password=`, so a working
//     credential reached stdout and any log shipper. The preflight reports
//     `database`/`role`/`bypassrls` from `current_database()` / `current_user`
//     instead — which is what an operator actually needs to confirm the target.
//   • Committing requires `--confirm`. `--dry-run` never does. A bare
//     invocation was previously a complete, valid production write (S4).
//   • Creating a tenant under a slug other than the draft's requires explicit
//     `--service` and `--rule`. Otherwise `--slug acme --name 'Acme Legal'`
//     silently gave Acme Pedro's two free services — which, since a
//     `price_cents = 0` service now books as `confirmed`, means anyone reaching
//     `/acme` could confirm slots on a calendar nobody meant to publish.
//
// ── Credentials: this needs BYPASSRLS, not merely ownership (S5) ─────────────
// `0002_rls_policies.sql` uses `force row level security`, which subjects even
// the table owner to the policies. The first `select` here runs before the
// `app.current_customer_id` GUC can be set — the id is what it is looking up —
// so a role without BYPASSRLS sees no rows, takes the create path, and hits a
// 23505 on the unique `slug`. It fails closed and says so, but it cannot
// converge. Criterion 1's "running it twice converges" therefore holds only for
// a BYPASSRLS role (CI's superuser, Supabase's `postgres`). Recorded on ALI-177
// because it means the tool runs with the highest-privilege credential
// available, which is the blast radius to plan around.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs --dry-run
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs --confirm \
//     --slug pedroestevez --name 'Pedro Estevez' \
//     --timezone America/New_York --currency USD \
//     --service 'Interview — 30 min|30|0' \
//     --rule '1-5|10:00|18:00|15'
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs --spec tenant.json --confirm
//
// `--dry-run` performs every read and write inside a transaction and then rolls
// it back, printing the same report a real run would. Always run it first.
//
// Prints the tenant slug as the last line of stdout on success, matching
// `seed-test-tenant.mjs`, so a caller can capture it.

import { readFile } from "node:fs/promises";

import { Client } from "pg";

/** The one variable this script will read a connection string from. */
const CONNECTION_VARIABLE = "PROVISION_DATABASE_URL";

/**
 * ALI-177 P4's draft defaults, 2026-08-17. 🔶 Pending Pedro's confirmation —
 * running this against production is P5 and is gated on that confirmation, not
 * on this file.
 *
 * These apply **on create only** (see the provenance note in the header). Two
 * fields are drafts the P4 table does not itself state, and are flagged on
 * ALI-176 rather than guessed silently:
 *   • `name`     — the display name behind slug `pedroestevez`.
 *   • `currency` — P4 lists a timezone but no currency. Both services are free,
 *                  so nothing formats a non-zero amount with it today.
 * `brandColor` matches `mapTenant`'s own fallback in `src/lib/supabase/rows.ts`,
 * so provisioning writes exactly what the app would have defaulted to.
 */
const DRAFT_SPEC = {
  slug: "pedroestevez",
  name: "Pedro Estevez",
  branding: {
    brandColor: "oklch(0.55 0.16 250)",
    currency: "USD",
    timezone: "America/New_York",
    // Where a guest is pointed when no confirmation email could be sent
    // (ALI-205). Without it the confirmation screen still says plainly that
    // nobody was notified, but offers no way to fix that.
    contactEmail: "pedroestevez001@gmail.com",
  },
  // No `customDomain` in the draft (ALI-211): unlike `branding`, this is not
  // filled in for a tenant being created from scratch — it is set only when
  // an operator explicitly passes `--custom-domain`, for exactly one tenant
  // (pedroestevez), never as a draft default other tenants would inherit.
  services: [
    {
      name: "Interview — 30 min",
      description: "A 30-minute interview slot.",
      durationMinutes: 30,
      priceCents: 0,
      active: true,
    },
    {
      name: "Intro consultation — 30 min",
      description: "A 30-minute introductory consultation.",
      durationMinutes: 30,
      priceCents: 0,
      active: true,
    },
  ],
  // Mon–Fri 10:00–18:00, buffer 15. One row per day: `availability_rules` has
  // no day-range column.
  availabilityRules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: "10:00",
    endTime: "18:00",
    bufferMinutes: 15,
  })),
};

const USAGE = `provision-tenant — provision one tenant, idempotently, deleting nothing.

Environment (required):
  ${CONNECTION_VARIABLE}   Postgres connection string naming BOTH a host and a
                           database. No fallback; unset or degenerate = exit 1.
                           Needs a role with BYPASSRLS (see the file header).

Options:
  --confirm                Required to COMMIT. Without it, only --dry-run runs.
  --dry-run                Do everything, then roll back. Prints the report.
  --spec <file>            JSON spec: { slug, name, branding, services, availabilityRules }
  --slug <slug>            Tenant slug (public URL segment)
  --name <name>            Tenant display name
  --timezone <iana>        branding_json.timezone, e.g. America/New_York
  --currency <iso4217>     branding_json.currency, e.g. USD
  --brand-color <css>      branding_json.brandColor
  --tagline <text>         branding_json.tagline
  --logo-url <url>         branding_json.logoUrl
  --contact-email <addr>   branding_json.contactEmail — the fallback contact
                           offered on the confirmation screen when no
                           notification email could be sent
  --custom-domain <host>   customers.custom_domain (ALI-211) — the host this
                           tenant is addressed at directly (e.g.
                           booking.pedroestevez.com), with no /<slug> prefix.
                           Lowercase only, matching the column's check
                           constraint. Not part of the P4 draft: set only when
                           this flag is passed, never inherited on create.
  --service '<name>|<minutes>|<price_cents>[|<description>]'
                           Repeatable. Any --service replaces the whole list.
  --rule '<days>|<start>|<end>|<buffer>'
                           Repeatable; <days> is 0-6, a range (1-5) or a list
                           (1,3,5). Any --rule replaces the whole list.
  -h, --help               This text.

Precedence: built-in P4 draft < --spec file < individual flags.

On an EXISTING tenant, only what the invocation supplies is written: an
unsupplied branding key, name, service list or rule list is left untouched.
The draft's values fill a tenant being CREATED, and nothing else.`;

/** A rejected input. Carries no connection or row data — just what is wrong. */
class SpecError extends Error {}

/**
 * A refusal decided after connecting. Always thrown inside the transaction, so
 * nothing is committed.
 */
class ProvisionError extends Error {}

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Parse argv into flag values. Unknown flags are an error rather than ignored:
 * a typo'd flag on a script that writes a live catalogue must not degrade into
 * "provisioned the defaults instead".
 */
function parseArgs(argv) {
  const flags = { services: [], rules: [] };

  const valueOf = (i, name) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SpecError(`${name} requires a value.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--confirm":
        flags.confirm = true;
        break;
      case "--spec":
        flags.specPath = valueOf(i, arg);
        i += 1;
        break;
      case "--slug":
        flags.slug = valueOf(i, arg);
        i += 1;
        break;
      case "--name":
        flags.name = valueOf(i, arg);
        i += 1;
        break;
      case "--timezone":
        flags.timezone = valueOf(i, arg);
        i += 1;
        break;
      case "--currency":
        flags.currency = valueOf(i, arg);
        i += 1;
        break;
      case "--brand-color":
        flags.brandColor = valueOf(i, arg);
        i += 1;
        break;
      case "--tagline":
        flags.tagline = valueOf(i, arg);
        i += 1;
        break;
      case "--logo-url":
        flags.logoUrl = valueOf(i, arg);
        i += 1;
        break;
      case "--contact-email":
        flags.contactEmail = valueOf(i, arg);
        i += 1;
        break;
      case "--custom-domain":
        flags.customDomain = valueOf(i, arg);
        i += 1;
        break;
      case "--service":
        flags.services.push(valueOf(i, arg));
        i += 1;
        break;
      case "--rule":
        flags.rules.push(valueOf(i, arg));
        i += 1;
        break;
      default:
        throw new SpecError(`Unknown argument: ${arg}`);
    }
  }

  return flags;
}

/** `'Interview — 30 min|30|0'` → a service object. Description is optional. */
function parseServiceFlag(value) {
  const parts = value.split("|");
  if (parts.length < 3 || parts.length > 4) {
    throw new SpecError(
      `--service must be '<name>|<minutes>|<price_cents>[|<description>]', got: ${value}`,
    );
  }
  const [name, minutes, priceCents, description] = parts;
  return {
    name: name.trim(),
    description: (description ?? "").trim(),
    durationMinutes: Number(minutes),
    priceCents: Number(priceCents),
    active: true,
  };
}

/** `'1-5'` / `'1,3,5'` / `'6'` → `[1,…]`. Values are validated later, not here. */
function parseDays(value) {
  const days = [];
  for (const part of value.split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        throw new SpecError(`--rule day range is inverted: ${part}`);
      }
      for (let d = from; d <= to; d += 1) days.push(d);
    } else {
      days.push(Number(part.trim()));
    }
  }
  return days;
}

/** `'1-5|10:00|18:00|15'` → one rule object per day named. */
function parseRuleFlag(value) {
  const parts = value.split("|");
  if (parts.length !== 4) {
    throw new SpecError(
      `--rule must be '<days>|<start>|<end>|<buffer>', got: ${value}`,
    );
  }
  const [days, startTime, endTime, buffer] = parts;
  return parseDays(days).map((dayOfWeek) => ({
    dayOfWeek,
    startTime: startTime.trim(),
    endTime: endTime.trim(),
    bufferMinutes: Number(buffer),
  }));
}

/**
 * Merge the built-in draft, an optional `--spec` file, and individual flags —
 * and record **which fields the invocation actually supplied**.
 *
 * That second return value is the whole of the S1 fix. Values alone cannot tell
 * "the operator asked for `America/New_York`" from "the draft happened to carry
 * it", and on an existing tenant those two mean opposite things.
 *
 * `services` / `availabilityRules` **replace** rather than merge when supplied:
 * half-merging a catalogue produces a state nobody asked for, whereas "any
 * `--service` means this is the service list" is a rule an operator can hold in
 * their head.
 */
async function buildSpec(flags) {
  const spec = structuredClone(DRAFT_SPEC);
  const supplied = {
    slug: false,
    name: false,
    /** Branding keys this invocation named, and only those. */
    branding: new Set(),
    services: false,
    availabilityRules: false,
    customDomain: false,
  };

  if (flags.specPath) {
    let raw;
    try {
      raw = await readFile(flags.specPath, "utf8");
    } catch {
      throw new SpecError(`Cannot read --spec file: ${flags.specPath}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SpecError(
        `--spec file is not valid JSON (${flags.specPath}): ${err.message}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SpecError(`--spec file must contain a JSON object.`);
    }

    if (parsed.branding !== null && typeof parsed.branding === "object") {
      for (const key of Object.keys(parsed.branding)) supplied.branding.add(key);
    } else if ("branding" in parsed) {
      throw new SpecError("--spec branding must be an object.");
    }
    if ("slug" in parsed) supplied.slug = true;
    if ("name" in parsed) supplied.name = true;
    if ("services" in parsed) supplied.services = true;
    if ("availabilityRules" in parsed) supplied.availabilityRules = true;
    if ("customDomain" in parsed) supplied.customDomain = true;

    Object.assign(spec, parsed, {
      branding: { ...spec.branding, ...(parsed.branding ?? {}) },
    });
  }

  const brandingFlags = {
    timezone: flags.timezone,
    currency: flags.currency,
    brandColor: flags.brandColor,
    tagline: flags.tagline,
    logoUrl: flags.logoUrl,
    contactEmail: flags.contactEmail,
  };
  for (const [key, value] of Object.entries(brandingFlags)) {
    if (value !== undefined) {
      spec.branding[key] = value;
      supplied.branding.add(key);
    }
  }

  if (flags.slug !== undefined) {
    spec.slug = flags.slug;
    supplied.slug = true;
  }
  if (flags.name !== undefined) {
    spec.name = flags.name;
    supplied.name = true;
  }
  if (flags.customDomain !== undefined) {
    spec.customDomain = flags.customDomain;
    supplied.customDomain = true;
  }
  if (flags.services.length > 0) {
    spec.services = flags.services.map(parseServiceFlag);
    supplied.services = true;
  }
  if (flags.rules.length > 0) {
    spec.availabilityRules = flags.rules.flatMap(parseRuleFlag);
    supplied.availabilityRules = true;
  }

  return { spec, supplied };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * A slug is a public URL segment (`booking.aligncompass.com/<slug>`), so this
 * is stricter than the column, which is merely `text not null unique`. A slug
 * containing `/`, whitespace or uppercase would resolve to a route nobody can
 * link to — better rejected here than provisioned and discovered later.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A `custom_domain` (ALI-211) is a full DNS hostname, not a URL segment: dot-
 * separated labels, each starting/ending alphanumeric. Lowercase-only, no
 * uppercase alternative — mirrors migration 0008's
 * `customers_custom_domain_lowercase` check constraint exactly, so an invalid
 * value is rejected here rather than by a 23514 after the insert.
 */
const CUSTOM_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Mirrors `isPlatformSharedHost` in `src/lib/request-host.ts` and migration
 * 0008's `customers_custom_domain_not_platform_host` check constraint. This
 * script is plain Node/`pg`, not the Next app, so it cannot import the
 * TypeScript source — keep this list in sync with both by hand. Rejected here
 * for a clear CLI error; the DB constraint is the backstop if this script is
 * ever bypassed.
 */
function isPlatformSharedHost(host) {
  return host === "booking.aligncompass.com" || host === "localhost" || host.endsWith(".vercel.app");
}

/** `HH:MM` or `HH:MM:SS`, 24h. Matches what `time` accepts and the UI renders. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SpecError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value, field, { min }) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SpecError(`${field} must be an integer, got: ${String(value)}`);
  }
  if (value < min) {
    throw new SpecError(`${field} must be >= ${min}, got: ${value}`);
  }
  return value;
}

/** Minutes since midnight, for the `start_time < end_time` check. */
function minutesOfDay(time) {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Reject everything the database would reject, plus the two things it cannot
 * see: an unroutable slug, and a duplicate convergence key.
 *
 * The duplicate checks matter more than they look. Convergence keys services by
 * name and rules by `(day, start, end)`; two spec entries sharing a key make
 * the second run's outcome depend on which row `limit 1` happened to pick. The
 * database has no unique index there — by design, a tenant may legitimately
 * have two same-named services — so this is the only place it can be caught.
 *
 * Runs **before** the connection is opened, so an invalid spec cannot write a
 * partial tenant even in principle.
 */
function validateSpec(spec) {
  requireNonEmptyString(spec.slug, "slug");
  if (!SLUG_PATTERN.test(spec.slug)) {
    throw new SpecError(
      `slug must be lowercase letters, digits and hyphens (a URL segment), got: ${spec.slug}`,
    );
  }
  requireNonEmptyString(spec.name, "name");

  if (spec.customDomain !== undefined) {
    requireNonEmptyString(spec.customDomain, "customDomain");
    if (!CUSTOM_DOMAIN_PATTERN.test(spec.customDomain)) {
      throw new SpecError(
        `customDomain must be a lowercase DNS hostname (e.g. ` +
          `booking.example.com), got: ${spec.customDomain}`,
      );
    }
    if (isPlatformSharedHost(spec.customDomain)) {
      throw new SpecError(
        `customDomain cannot be one of the platform's own hosts ` +
          `(booking.aligncompass.com, localhost, or any *.vercel.app host) — ` +
          `got: ${spec.customDomain}. The app never resolves a tenant for ` +
          `these hosts, so this tenant's booking page would become ` +
          `unreachable via both the slug route and the shared host.`,
      );
    }
  }

  const branding = spec.branding;
  if (branding === null || typeof branding !== "object") {
    throw new SpecError("branding must be an object.");
  }
  requireNonEmptyString(branding.brandColor, "branding.brandColor");
  requireNonEmptyString(branding.timezone, "branding.timezone");
  requireNonEmptyString(branding.currency, "branding.currency");

  // `branding_json.timezone` is what the UI formats every slot against, and
  // `branding_json.currency` what it formats prices with. Both fail at render
  // time, per visitor, if they are wrong — so they are checked here, with the
  // same runtime that will do the formatting.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: branding.timezone });
  } catch {
    throw new SpecError(
      `branding.timezone is not a valid IANA timezone: ${branding.timezone}`,
    );
  }
  if (!/^[A-Z]{3}$/.test(branding.currency)) {
    throw new SpecError(
      `branding.currency must be a 3-letter ISO 4217 code, got: ${branding.currency}`,
    );
  }
  try {
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: branding.currency,
    });
  } catch {
    throw new SpecError(
      `branding.currency is not a currency this runtime knows: ${branding.currency}`,
    );
  }

  if (!Array.isArray(spec.services) || spec.services.length === 0) {
    throw new SpecError("services must be a non-empty array.");
  }
  const serviceNames = new Set();
  spec.services.forEach((service, i) => {
    const at = `services[${i}]`;
    if (service === null || typeof service !== "object") {
      throw new SpecError(`${at} must be an object.`);
    }
    requireNonEmptyString(service.name, `${at}.name`);
    if (serviceNames.has(service.name)) {
      throw new SpecError(
        `${at}.name duplicates an earlier service (${service.name}); ` +
          "names are this script's convergence key and must be unique.",
      );
    }
    serviceNames.add(service.name);
    // Mirrors `check (duration_minutes > 0)` in migration 0001.
    requireInteger(service.durationMinutes, `${at}.durationMinutes`, { min: 1 });
    // Mirrors `check (price_cents >= 0)` in migration 0001.
    requireInteger(service.priceCents, `${at}.priceCents`, { min: 0 });
    if (service.description !== undefined && typeof service.description !== "string") {
      throw new SpecError(`${at}.description must be a string.`);
    }
    if (service.active !== undefined && typeof service.active !== "boolean") {
      throw new SpecError(`${at}.active must be a boolean.`);
    }
  });

  if (!Array.isArray(spec.availabilityRules) || spec.availabilityRules.length === 0) {
    throw new SpecError("availabilityRules must be a non-empty array.");
  }
  const ruleKeys = new Set();
  spec.availabilityRules.forEach((rule, i) => {
    const at = `availabilityRules[${i}]`;
    if (rule === null || typeof rule !== "object") {
      throw new SpecError(`${at} must be an object.`);
    }
    // Mirrors `check (day_of_week between 0 and 6)` in migration 0001.
    requireInteger(rule.dayOfWeek, `${at}.dayOfWeek`, { min: 0 });
    if (rule.dayOfWeek > 6) {
      throw new SpecError(
        `${at}.dayOfWeek must be 0 (Sunday) through 6 (Saturday), got: ${rule.dayOfWeek}`,
      );
    }
    for (const field of ["startTime", "endTime"]) {
      requireNonEmptyString(rule[field], `${at}.${field}`);
      if (!TIME_PATTERN.test(rule[field])) {
        throw new SpecError(
          `${at}.${field} must be 'HH:MM' or 'HH:MM:SS', got: ${rule[field]}`,
        );
      }
    }
    // Mirrors `constraint availability_rules_time_order check (start_time < end_time)`.
    if (minutesOfDay(rule.startTime) >= minutesOfDay(rule.endTime)) {
      throw new SpecError(
        `${at}.startTime must be earlier than endTime (${rule.startTime} → ${rule.endTime}).`,
      );
    }
    // Mirrors `check (buffer_minutes >= 0)` in migration 0001.
    requireInteger(rule.bufferMinutes, `${at}.bufferMinutes`, { min: 0 });

    const key = `${rule.dayOfWeek}|${rule.startTime}|${rule.endTime}`;
    if (ruleKeys.has(key)) {
      throw new SpecError(
        `${at} duplicates an earlier rule (${key}); (day, start, end) is this ` +
          "script's convergence key and must be unique.",
      );
    }
    ruleKeys.add(key);
  });

  return spec;
}

/**
 * The connection variable must **name its target** (S2).
 *
 * A presence check is not a guard. `PROVISION_DATABASE_URL=postgres://` is
 * truthy and node-postgres then reads the host, user and database from ambient
 * `PGHOST`/`PGUSER`/`PGDATABASE` — precisely the "falls back to a default
 * connection string" behaviour this variable's own error text promises it does
 * not have. A secret template that renders empty (`postgres://$DB_SECRET` with
 * the secret unset) produces exactly that value, and a CI container with `PG*`
 * pointed at production turns it into a production write.
 *
 * Returns the host and database the variable names, so the run can also verify
 * after connecting that it actually reached them.
 */
function parseConnectionTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SpecError(
      `${CONNECTION_VARIABLE} must be a postgres:// URL naming a host and a ` +
        "database. It could not be parsed as a URL at all.",
    );
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new SpecError(
      `${CONNECTION_VARIABLE} must use the postgres:// or postgresql:// scheme, ` +
        `got: ${url.protocol}`,
    );
  }
  if (!url.hostname) {
    throw new SpecError(
      `${CONNECTION_VARIABLE} names no host. Without one the host would come ` +
        "from the ambient PGHOST, which is the fallback this variable exists to " +
        "prevent. Spell the host out.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new SpecError(
      `${CONNECTION_VARIABLE} names no database. Without one the database would ` +
        "come from the ambient PGDATABASE, which is the fallback this variable " +
        "exists to prevent. Spell the database out.",
    );
  }
  return { host: url.hostname, database };
}

// ── Provisioning ─────────────────────────────────────────────────────────────

/**
 * Set the tenant context the RLS policies in `0002_rls_policies.sql` key off,
 * transaction-locally. Needed for the write paths under a non-BYPASSRLS role,
 * and harmless under one that bypasses — so it is set unconditionally rather
 * than depending on which credential the operator used.
 */
async function setTenantContext(client, customerId) {
  await client.query("select set_config('app.current_customer_id', $1, true)", [
    customerId,
  ]);
}

/** The tenant with this slug, or `undefined`. Read-only. */
async function findTenant(client, slug) {
  const { rows } = await client.query(
    "select id from public.customers where slug = $1",
    [slug],
  );
  return rows[0]?.id;
}

/**
 * Create the tenant. The draft's values are legitimate here: there is no
 * pre-existing row whose configuration could be overwritten.
 */
async function createTenant(client, spec) {
  const generated = await client.query("select gen_random_uuid() as id");
  const id = generated.rows[0].id;
  await setTenantContext(client, id);

  try {
    await client.query(
      `insert into public.customers (id, name, slug, branding_json, custom_domain)
       values ($1, $2, $3, $4::jsonb, $5)`,
      [
        id,
        spec.name,
        spec.slug,
        JSON.stringify(spec.branding),
        spec.customDomain ?? null,
      ],
    );
  } catch (err) {
    if (err.code === "23505") {
      // The row exists but `findTenant` could not see it. Under 0002's
      // `force row level security` that is what a role WITHOUT BYPASSRLS sees —
      // including the table owner, which `force` is precisely what subjects to
      // the policies (S5: the earlier wording here said the owner would do, and
      // it will not). The other cause is a concurrent run, which the advisory
      // lock makes unlikely but not impossible across databases.
      throw new ProvisionError(
        `A tenant with slug '${spec.slug}' already exists but was not visible ` +
          "to this connection. Either another run created it concurrently, or " +
          "this role reads through row-level security and cannot see it. " +
          "`force row level security` (migration 0002) applies the policies to " +
          "the table owner too, so ownership is not enough: reconnect with a " +
          "role that holds BYPASSRLS (CI's superuser, Supabase's `postgres`) " +
          "and re-run. Nothing was changed.",
      );
    }
    throw err;
  }

  return id;
}

/**
 * Update the tenant with **only** what this invocation supplied (S1).
 *
 * Nothing is written when nothing was supplied — not even a no-op `update`,
 * so a run that only converges the catalogue cannot touch `customers` at all.
 * `branding_json` is merged with a patch containing exactly the supplied keys,
 * which is what leaves an owner-set `timezone` (or `logoUrl`, or anything a
 * future migration adds) byte-identical.
 */
async function updateTenant(client, customerId, spec, supplied) {
  await setTenantContext(client, customerId);

  const brandingPatch = {};
  for (const key of supplied.branding) brandingPatch[key] = spec.branding[key];

  const sets = [];
  const params = [customerId];
  if (supplied.name) {
    params.push(spec.name);
    sets.push(`name = $${params.length}`);
  }
  if (Object.keys(brandingPatch).length > 0) {
    params.push(JSON.stringify(brandingPatch));
    sets.push(
      `branding_json = coalesce(branding_json, '{}'::jsonb) || $${params.length}::jsonb`,
    );
  }
  if (supplied.customDomain) {
    params.push(spec.customDomain);
    sets.push(`custom_domain = $${params.length}`);
  }

  if (sets.length === 0) {
    return { name: false, brandingKeys: [], customDomain: false };
  }

  // Column names are literals from this file; every value is a placeholder.
  await client.query(
    `update public.customers set ${sets.join(", ")} where id = $1`,
    params,
  );

  return {
    name: supplied.name,
    brandingKeys: Object.keys(brandingPatch),
    customDomain: supplied.customDomain,
  };
}

/** Converge `services` by `(customer_id, name)`. Never deletes. */
async function convergeServices(client, customerId, services) {
  const report = { created: 0, updated: 0, unmanaged: [] };

  for (const service of services) {
    const existing = await client.query(
      "select id from public.services where customer_id = $1 and name = $2 order by id limit 1",
      [customerId, service.name],
    );

    if (existing.rows.length > 0) {
      await client.query(
        `update public.services
            set description = $3, duration_minutes = $4, price_cents = $5, active = $6
          where id = $1 and customer_id = $2`,
        [
          existing.rows[0].id,
          customerId,
          service.description ?? "",
          service.durationMinutes,
          service.priceCents,
          service.active ?? true,
        ],
      );
      report.updated += 1;
    } else {
      await client.query(
        `insert into public.services
           (customer_id, name, description, duration_minutes, price_cents, active)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          customerId,
          service.name,
          service.description ?? "",
          service.durationMinutes,
          service.priceCents,
          service.active ?? true,
        ],
      );
      report.created += 1;
    }
  }

  const names = services.map((s) => s.name);
  const extras = await client.query(
    "select name from public.services where customer_id = $1 and not (name = any($2::text[])) order by name",
    [customerId, names],
  );
  report.unmanaged = extras.rows.map((r) => r.name);

  return report;
}

/** Converge `availability_rules` by `(customer_id, day, start, end)`. Never deletes. */
async function convergeAvailabilityRules(client, customerId, rules) {
  const report = { created: 0, updated: 0, unmanaged: [] };

  for (const rule of rules) {
    const existing = await client.query(
      `select id from public.availability_rules
        where customer_id = $1
          and day_of_week = $2
          and start_time = $3::time
          and end_time = $4::time
        order by id limit 1`,
      [customerId, rule.dayOfWeek, rule.startTime, rule.endTime],
    );

    if (existing.rows.length > 0) {
      await client.query(
        `update public.availability_rules
            set buffer_minutes = $3
          where id = $1 and customer_id = $2`,
        [existing.rows[0].id, customerId, rule.bufferMinutes],
      );
      report.updated += 1;
    } else {
      await client.query(
        `insert into public.availability_rules
           (customer_id, day_of_week, start_time, end_time, buffer_minutes)
         values ($1, $2, $3::time, $4::time, $5)`,
        [
          customerId,
          rule.dayOfWeek,
          rule.startTime,
          rule.endTime,
          rule.bufferMinutes,
        ],
      );
      report.created += 1;
    }
  }

  // `to_char` so the comparison is against the same `HH:MM` shape the spec
  // uses, rather than Postgres's `HH:MM:SS` rendering of `time`.
  const keys = rules.map((r) => `${r.dayOfWeek}|${r.startTime}|${r.endTime}`);
  const extras = await client.query(
    `select day_of_week, to_char(start_time, 'HH24:MI') as start_time,
            to_char(end_time, 'HH24:MI') as end_time
       from public.availability_rules
      where customer_id = $1
        and (day_of_week || '|' || to_char(start_time, 'HH24:MI') || '|' ||
             to_char(end_time, 'HH24:MI')) <> all($2::text[])
      order by day_of_week, start_time`,
    [customerId, keys],
  );
  report.unmanaged = extras.rows.map(
    (r) => `day ${r.day_of_week} ${r.start_time}–${r.end_time}`,
  );

  return report;
}

/**
 * Creating a tenant under a slug other than the draft's must not inherit the
 * draft's catalogue (S4).
 *
 * `--slug acme --name 'Acme Legal'` used to give Acme Pedro's two services.
 * They are `active` and `price_cents = 0`, and a free service now books as
 * `confirmed`, so anyone reaching `/acme` could confirm slots on a calendar
 * nobody meant to publish — and, once ALI-69 lands, trigger a confirmation
 * email. Only the draft tenant may be created from the draft catalogue.
 */
function requireExplicitCatalogueForNewTenant(spec, supplied) {
  if (spec.slug === DRAFT_SPEC.slug) return;

  const missing = [];
  if (!supplied.services) missing.push("--service");
  if (!supplied.availabilityRules) missing.push("--rule");
  if (missing.length === 0) return;

  throw new ProvisionError(
    `Refusing to create tenant '${spec.slug}' from the ALI-177 P4 draft ` +
      `catalogue. Pass ${missing.join(" and ")} explicitly (or a --spec file ` +
      "listing them): the draft's services are free and active, and a free " +
      "service books as confirmed, so inheriting them would publish a bookable " +
      "calendar nobody configured. Nothing was written.",
  );
}

/**
 * One transaction: resolve or create the tenant, converge what was supplied,
 * report.
 *
 * The advisory lock is keyed on the slug so two concurrent runs for the same
 * tenant serialize instead of racing between the "does this service exist?"
 * read and the insert that follows it. It is transaction-scoped, so it is
 * released by the commit or the rollback, including `--dry-run`'s.
 */
async function provision(client, spec, supplied, { dryRun }) {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `provision-tenant:${spec.slug}`,
    ]);

    const existingId = await findTenant(client, spec.slug);
    const created = existingId === undefined;

    let customerId;
    let tenantWrites = { name: true, brandingKeys: [] };
    if (created) {
      requireExplicitCatalogueForNewTenant(spec, supplied);
      customerId = await createTenant(client, spec);
      tenantWrites = {
        name: true,
        brandingKeys: Object.keys(spec.branding),
        customDomain: spec.customDomain !== undefined,
      };
    } else {
      customerId = existingId;
      tenantWrites = await updateTenant(client, customerId, spec, supplied);
    }

    // On an existing tenant, an unsupplied catalogue is not an empty catalogue:
    // it is "leave it as it is". Converging the draft here is what S1 was, one
    // table over — a re-run meant to fix a tagline would rewrite every price.
    const convergeCatalogue = created || supplied.services;
    const convergeRules = created || supplied.availabilityRules;

    const services = convergeCatalogue
      ? await convergeServices(client, customerId, spec.services)
      : null;
    const rules = convergeRules
      ? await convergeAvailabilityRules(client, customerId, spec.availabilityRules)
      : null;

    if (dryRun) {
      await client.query("rollback");
    } else {
      await client.query("commit");
    }

    return { customerId, created, tenantWrites, services, rules };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

function reportTenantWrites(report) {
  if (report.created) {
    console.log(`provision-tenant: tenant created (${report.customerId})`);
    return;
  }
  const wrote = [];
  if (report.tenantWrites.name) wrote.push("name");
  for (const key of report.tenantWrites.brandingKeys) wrote.push(`branding.${key}`);
  if (report.tenantWrites.customDomain) wrote.push("customDomain");
  console.log(
    wrote.length > 0
      ? `provision-tenant: tenant updated (${report.customerId}) — wrote ${wrote.join(", ")}`
      : `provision-tenant: tenant unchanged (${report.customerId}) — no ` +
          "name, branding or customDomain value was supplied, so none was written",
  );
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`provision-tenant: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  // The guard, before anything else can happen. No fallback variable, no
  // default host: unset means stop.
  const databaseUrl = process.env[CONNECTION_VARIABLE];
  if (!databaseUrl) {
    console.error(
      `provision-tenant: ${CONNECTION_VARIABLE} is not set. This script ` +
        "writes a real tenant catalogue, so it never guesses a database and " +
        `never falls back to DATABASE_URL or TEST_DATABASE_URL. Set ` +
        `${CONNECTION_VARIABLE} to the connection string of the database you ` +
        "intend to provision and re-run. Nothing was written.",
    );
    process.exitCode = 1;
    return;
  }

  // Committing is opt-in. A bare invocation must not be a complete production
  // write (S4) — `--dry-run` is the safe default path, `--confirm` the loud one.
  if (!flags.dryRun && !flags.confirm) {
    console.error(
      "provision-tenant: refusing to write without --confirm. Run with " +
        "--dry-run first to see exactly what would change, then re-run the same " +
        "command with --confirm to commit it. Nothing was written.",
    );
    process.exitCode = 2;
    return;
  }

  let spec;
  let supplied;
  let target;
  try {
    ({ spec, supplied } = await buildSpec(flags));
    validateSpec(spec);
    // Part of input validation, and deliberately before `new Client`.
    target = parseConnectionTarget(databaseUrl);
  } catch (err) {
    if (err instanceof SpecError) {
      console.error(`provision-tenant: invalid input — ${err.message}`);
      console.error("Nothing was written.");
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const preflight = await client.query(
      `select current_user as role, current_database() as database,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`,
    );
    const { role, database, bypassrls } = preflight.rows[0];

    // The connection string is never printed — it can carry a credential in
    // either the userinfo or a `?password=` parameter (S3). The server's own
    // answer is both safer and more truthful about where we landed.
    console.log(
      `provision-tenant: connected to database=${database}, role=${role}, ` +
        `bypassrls=${bypassrls === true}`,
    );

    // Belt to `parseConnectionTarget`'s braces: if anything between the
    // variable and the server redirected us, stop before writing.
    if (database !== target.database) {
      console.error(
        `provision-tenant: ${CONNECTION_VARIABLE} names database ` +
          `'${target.database}' but the connection reached '${database}'. ` +
          "Refusing to write to a database the variable did not name. Nothing " +
          "was written.",
      );
      process.exitCode = 1;
      return;
    }
    if (bypassrls !== true) {
      // Not fatal — a create-only run works, and the failure mode is a clean
      // 23505 rather than corruption. But convergence needs BYPASSRLS (S5), so
      // say it before the operator discovers it on the second run.
      console.log(
        "provision-tenant: WARNING — this role does not hold BYPASSRLS. " +
          "`force row level security` (migration 0002) hides existing rows from " +
          "it, so a re-run cannot converge and will fail on the unique slug.",
      );
    }

    console.log(
      `provision-tenant: ${flags.dryRun ? "DRY RUN — " : ""}slug=${spec.slug}, ` +
        `supplied: name=${supplied.name}, branding=[${[...supplied.branding].join(",") || "none"}], ` +
        `services=${supplied.services}, rules=${supplied.availabilityRules}, ` +
        `customDomain=${supplied.customDomain}`,
    );

    const report = await provision(client, spec, supplied, {
      dryRun: Boolean(flags.dryRun),
    });

    reportTenantWrites(report);
    if (report.services) {
      console.log(
        `provision-tenant: services +${report.services.created} ~${report.services.updated}`,
      );
      for (const name of report.services.unmanaged) {
        console.log(`provision-tenant: leaving existing service in place: ${name}`);
      }
    } else {
      console.log(
        "provision-tenant: no services supplied — existing catalogue left untouched",
      );
    }
    if (report.rules) {
      console.log(
        `provision-tenant: rules +${report.rules.created} ~${report.rules.updated}`,
      );
      for (const key of report.rules.unmanaged) {
        console.log(`provision-tenant: leaving existing availability rule in place: ${key}`);
      }
    } else {
      console.log(
        "provision-tenant: no availability rules supplied — existing rules left untouched",
      );
    }
    if (flags.dryRun) {
      console.log("provision-tenant: DRY RUN — rolled back, nothing was written.");
    }
  } catch (err) {
    console.error("provision-tenant: FAILED. Nothing was committed.");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }

  console.log(spec.slug);
}

main().catch((err) => {
  console.error("provision-tenant: unexpected failure");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
