#!/usr/bin/env node
// scripts/apply-migrations.mjs — ALI-114
//
// Applies every `supabase/migrations/*.sql` file, in filename order, against
// `TEST_DATABASE_URL` using a direct `pg` connection.
//
// Why a direct Postgres connection and not the Supabase JS client: the
// Supabase client talks to PostgREST over HTTP, and a throwaway
// `postgres:16` service container has no PostgREST in front of it — only
// plain Postgres. Applying raw `.sql` files needs nothing more than that.
// (`src/test/supabase-harness.ts` documents the same reasoning for the test
// suite itself.)
//
// Fails loudly: on any statement error, this prints the offending migration
// file's name and exits non-zero rather than continuing past a broken
// migration. Intended to run once against a freshly created, disposable
// database (a CI service container, or a local `docker run postgres:16`) —
// see `supabase/README.md` for the one-command local reproduction.
//
// Before applying any migration, this bootstraps the three Postgres roles
// (`anon`, `authenticated`, `service_role`) that migration 0002 (and 0003)
// `grant`/`revoke` against. A real Supabase project pre-provisions these
// roles; a vanilla `postgres:16` container does not, so without this the
// very first `grant ... to anon` fails with "role anon does not exist". This
// does NOT touch the migration files themselves — it only pre-creates the
// roles they assume already exist, mirroring what Supabase does for us
// against a hosted project.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");

// Supabase-managed roles the migrations assume exist. NOLOGIN: nothing ever
// authenticates as them directly in this hermetic setup, they only need to
// exist as GRANT/REVOKE targets.
const SUPABASE_MANAGED_ROLES = ["anon", "authenticated", "service_role"];

async function bootstrapSupabaseRoles(client) {
  for (const role of SUPABASE_MANAGED_ROLES) {
    await client.query(
      `do $$
       begin
         if not exists (select from pg_roles where rolname = '${role}') then
           create role ${role} nologin;
         end if;
       end
       $$;`,
    );
  }
  console.log(
    `apply-migrations: ensured Supabase-managed roles exist (${SUPABASE_MANAGED_ROLES.join(", ")}).`,
  );
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "apply-migrations: TEST_DATABASE_URL is not set. Point it at a " +
        "disposable Postgres database (never production) and re-run.",
    );
    process.exitCode = 1;
    return;
  }

  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  if (files.length === 0) {
    console.error(`apply-migrations: no .sql files found in ${MIGRATIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    try {
      await bootstrapSupabaseRoles(client);
    } catch (err) {
      console.error("apply-migrations: FAILED bootstrapping Supabase-managed roles");
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    }

    for (const file of files) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = await readFile(filePath, "utf8");

      console.log(`apply-migrations: applying ${file}`);

      try {
        await client.query("begin");
        // A plain (unparameterized) `query()` call uses Postgres's simple
        // query protocol, which allows a single call to run every statement
        // in the file, including the `$$`-delimited function bodies in
        // 0002/0003.
        await client.query(sql);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error(`apply-migrations: FAILED applying ${file}`);
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`apply-migrations: applied ${files.length} migration(s) successfully.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("apply-migrations: unexpected failure");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
