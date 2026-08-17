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
//   • `customers`      — matched by its unique `slug`. `branding_json` is
//                        *merged* (`||`), so keys this spec does not mention
//                        (a hand-set `logoUrl`, say) survive the run.
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
// ── The connection guard ────────────────────────────────────────────────────
// `PROVISION_DATABASE_URL` must be set explicitly. There is no fallback: not
// `DATABASE_URL`, not `TEST_DATABASE_URL`, not localhost. Unset → exit 1 before
// a socket is opened. A script that can write a real tenant catalogue must not
// be able to find a database by accident, and the variable is deliberately one
// no other tool in this repo sets, so pointing it somewhere is always a choice.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs --dry-run
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs \
//     --slug pedroestevez --name 'Pedro Estevez' \
//     --timezone America/New_York --currency USD \
//     --service 'Interview — 30 min|30|0' \
//     --rule '1-5|10:00|18:00|15'
//   PROVISION_DATABASE_URL=postgres://… node scripts/provision-tenant.mjs --spec tenant.json
//
// `--dry-run` performs every read and write inside a transaction and then rolls
// it back, printing the same report a real run would. Prefer it first against
// production.
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
 * Two fields are drafts the P4 table does not itself state, and are flagged on
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
  },
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
  ${CONNECTION_VARIABLE}   Postgres connection string. No fallback; unset = exit 1.

Options:
  --spec <file>            JSON spec: { slug, name, branding, services, availabilityRules }
  --slug <slug>            Tenant slug (public URL segment)
  --name <name>            Tenant display name
  --timezone <iana>        branding_json.timezone, e.g. America/New_York
  --currency <iso4217>     branding_json.currency, e.g. USD
  --brand-color <css>      branding_json.brandColor
  --tagline <text>         branding_json.tagline
  --logo-url <url>         branding_json.logoUrl
  --service '<name>|<minutes>|<price_cents>[|<description>]'
                           Repeatable. Any --service replaces the whole list.
  --rule '<days>|<start>|<end>|<buffer>'
                           Repeatable; <days> is 0-6, a range (1-5) or a list
                           (1,3,5). Any --rule replaces the whole list.
  --dry-run                Do everything, then roll back. Prints the report.
  -h, --help               This text.

Precedence: built-in P4 draft < --spec file < individual flags.`;

/** A rejected input. Carries no connection or row data — just what is wrong. */
class SpecError extends Error {}

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
 * Merge the built-in draft, an optional `--spec` file, and individual flags.
 *
 * `services` / `availabilityRules` **replace** rather than merge: half-merging
 * a catalogue produces a state nobody asked for, whereas "any `--service` means
 * this is the service list" is a rule an operator can hold in their head.
 */
async function buildSpec(flags) {
  let spec = structuredClone(DRAFT_SPEC);

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
    spec = {
      ...spec,
      ...parsed,
      branding: { ...spec.branding, ...(parsed.branding ?? {}) },
    };
  }

  if (flags.slug !== undefined) spec.slug = flags.slug;
  if (flags.name !== undefined) spec.name = flags.name;
  if (flags.timezone !== undefined) spec.branding.timezone = flags.timezone;
  if (flags.currency !== undefined) spec.branding.currency = flags.currency;
  if (flags.brandColor !== undefined) spec.branding.brandColor = flags.brandColor;
  if (flags.tagline !== undefined) spec.branding.tagline = flags.tagline;
  if (flags.logoUrl !== undefined) spec.branding.logoUrl = flags.logoUrl;

  if (flags.services.length > 0) {
    spec.services = flags.services.map(parseServiceFlag);
  }
  if (flags.rules.length > 0) {
    spec.availabilityRules = flags.rules.flatMap(parseRuleFlag);
  }

  return spec;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * A slug is a public URL segment (`booking.aligncompass.com/<slug>`), so this
 * is stricter than the column, which is merely `text not null unique`. A slug
 * containing `/`, whitespace or uppercase would resolve to a route nobody can
 * link to — better rejected here than provisioned and discovered later.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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

// ── Provisioning ─────────────────────────────────────────────────────────────

/**
 * Resolve the tenant by slug, creating it if absent. Returns its id and whether
 * this run created it.
 *
 * The `app.current_customer_id` GUC is set as soon as the id is known, so every
 * later statement satisfies the RLS policies from `0002_rls_policies.sql`
 * (`force row level security`, keyed off that GUC) whether or not the
 * connecting role holds BYPASSRLS. A role that reads through RLS cannot see the
 * existing row here, which would otherwise silently re-insert; the unique index
 * on `slug` turns that into a loud 23505, translated below.
 */
async function resolveTenant(client, spec) {
  const found = await client.query(
    "select id from public.customers where slug = $1",
    [spec.slug],
  );

  if (found.rows.length > 0) {
    const id = found.rows[0].id;
    await client.query("select set_config('app.current_customer_id', $1, true)", [id]);
    await client.query(
      `update public.customers
          set name = $2,
              branding_json = coalesce(branding_json, '{}'::jsonb) || $3::jsonb
        where id = $1`,
      [id, spec.name, JSON.stringify(spec.branding)],
    );
    return { customerId: id, created: false };
  }

  const generated = await client.query("select gen_random_uuid() as id");
  const id = generated.rows[0].id;
  await client.query("select set_config('app.current_customer_id', $1, true)", [id]);

  try {
    await client.query(
      `insert into public.customers (id, name, slug, branding_json)
       values ($1, $2, $3, $4::jsonb)`,
      [id, spec.name, spec.slug, JSON.stringify(spec.branding)],
    );
  } catch (err) {
    if (err.code === "23505") {
      throw new Error(
        `A tenant with slug '${spec.slug}' already exists but was not visible ` +
          "to this connection. Either another run created it concurrently, or " +
          "this role reads through row-level security and cannot see it — " +
          "reconnect with a role that holds BYPASSRLS (or the table owner) and " +
          "re-run. Nothing was changed.",
      );
    }
    throw err;
  }

  return { customerId: id, created: true };
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
 * One transaction: resolve/create the tenant, converge its catalogue, report.
 *
 * The advisory lock is keyed on the slug so two concurrent runs for the same
 * tenant serialize instead of racing between the "does this service exist?"
 * read and the insert that follows it. It is transaction-scoped, so it is
 * released by the commit or the rollback, including `--dry-run`'s.
 */
async function provision(client, spec, { dryRun }) {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `provision-tenant:${spec.slug}`,
    ]);

    const tenant = await resolveTenant(client, spec);
    const services = await convergeServices(client, tenant.customerId, spec.services);
    const rules = await convergeAvailabilityRules(
      client,
      tenant.customerId,
      spec.availabilityRules,
    );

    if (dryRun) {
      await client.query("rollback");
    } else {
      await client.query("commit");
    }

    return { ...tenant, services, rules };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

/** A connection string with any password removed, safe to print. */
function redact(connectionString) {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    // Not URL-shaped (a libpq keyword/value string, say). Print nothing rather
    // than risk printing a secret.
    return "(unparseable connection string, not shown)";
  }
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

  let spec;
  try {
    spec = validateSpec(await buildSpec(flags));
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
    console.log(
      `provision-tenant: ${redact(databaseUrl)} (database=${database}, ` +
        `role=${role}, bypassrls=${bypassrls === true})`,
    );
    console.log(
      `provision-tenant: ${flags.dryRun ? "DRY RUN — " : ""}slug=${spec.slug}, ` +
        `services=${spec.services.length}, rules=${spec.availabilityRules.length}, ` +
        `timezone=${spec.branding.timezone}, currency=${spec.branding.currency}`,
    );

    const report = await provision(client, spec, { dryRun: Boolean(flags.dryRun) });

    console.log(
      `provision-tenant: tenant ${report.created ? "created" : "updated"} ` +
        `(${report.customerId})`,
    );
    console.log(
      `provision-tenant: services +${report.services.created} ~${report.services.updated}; ` +
        `rules +${report.rules.created} ~${report.rules.updated}`,
    );
    for (const name of report.services.unmanaged) {
      console.log(`provision-tenant: leaving existing service in place: ${name}`);
    }
    for (const key of report.rules.unmanaged) {
      console.log(`provision-tenant: leaving existing availability rule in place: ${key}`);
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
