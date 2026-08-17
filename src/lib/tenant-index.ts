/**
 * Whether the platform root (`/`) may list the tenants this deployment hosts
 * (ALI-176 criterion 3).
 *
 * ## Why the root had to stop enumerating tenants
 *
 * `getAllTenants()` selects every `customers` row with no filter, and `/`
 * rendered each one's name and slug under `force-dynamic`. That is an internal
 * development index published at the platform's front door: today it would list
 * the two seed fixtures, and from tenant #1 onward it lists every real business
 * on the platform, to anyone who loads the page. Competitors get the customer
 * list; a booker gets a directory of other people's calendars.
 *
 * RLS would not have caught this. `getAllTenants()` is *supposed* to return
 * every row — it is the call site that is wrong, which is why the gate lives
 * here and in `src/app/page.tsx` rather than in `src/lib/tenants.ts`.
 *
 * ## Fail closed: one positive condition, everything else hides it
 *
 * The index renders only when `NODE_ENV === "development"`, i.e. under
 * `next dev` on a developer's machine. Every other value hides it, including
 * `production`, `test`, an unrecognised value, and unset. That direction matters
 * more than the specific check: a gate written as `!== "production"` publishes
 * the list on any deployment whose environment is unset or mislabelled, and a
 * gate is only worth having if the failure mode is a blank page rather than a
 * leak. `next build`/`next start` and every Vercel build (preview included) run
 * with `NODE_ENV=production`, so no deployed environment can reach it.
 *
 * Takes `env` as a parameter so a test can assert the whole truth table without
 * mutating the process, and defaults to `process.env` so call sites read
 * naturally.
 */
export function tenantIndexEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "development";
}
