/**
 * One faithful in-memory model of `public.resolve_or_create_end_customer`
 * (migration 0007), shared by every suite that fakes the Supabase driver.
 *
 * ## Why this is a module and not a closure inside a test file
 *
 * ALI-167 exists partly because the fake lied. Before this file,
 * `booking-tenant-scope.test.ts` faked the RPC as "find the row, return its id"
 * and never stored `name` or `phone` at all — which happens to describe the
 * *desired* post-fix behaviour, while the real function overwrote the stored
 * name. So the entire app-layer suite passed on the vulnerable code, and no
 * test built on that fake could have failed on the bug or proved the fix.
 *
 * The lesson is not "write a better fake in each file" — two fakes drift, and
 * the drift is invisible. There is exactly ONE model of this function's
 * semantics in the test suite, it lives here, and it is pinned to the real
 * database by `src/test/__tests__/guest-identity.db.test.ts`, which runs
 * `IDENTITY_CONFLICT_CASES` below against a live Postgres. If this model and
 * Postgres ever disagree, that suite goes red.
 *
 * ## What it models, including the rejections
 *
 * A fake that only ever says yes is a model of success, not of the system. The
 * real function is `security definer` over a table with a `not null` email and
 * a foreign key to `customers`, so it *rejects* things, and so does this:
 *
 *   • a null/absent `p_email` → SQLSTATE 23502 (not_null_violation)
 *   • a `p_customer_id` naming no customer → SQLSTATE 23503 (foreign_key_violation)
 *
 * Both are returned in the PostgREST shape (`{ data: null, error }`) rather
 * than thrown, because that is how they reach `createBooking`.
 */

/** A row of the fake `end_customers` table. */
export interface FakeEndCustomerRow {
  id: string;
  customer_id: string;
  email: string;
  name: string;
  phone: string | null;
  [column: string]: unknown;
}

/** The slice of a fake database this function touches. */
export interface FakeIdentityStore {
  /** Rows of the fake `customers` table — the foreign key's referent. */
  customers: ReadonlyArray<{ [column: string]: unknown }>;
  end_customers: FakeEndCustomerRow[];
}

/** The error shape PostgREST returns for a failed `.rpc()` call. */
export interface FakeRpcError {
  code: string;
  message: string;
  details: string;
  hint: string;
}

export interface FakeRpcResult {
  data: string | null;
  error: FakeRpcError | null;
}

export interface ResolveIdentityArgs {
  p_customer_id?: unknown;
  p_email?: unknown;
  p_name?: unknown;
  p_phone?: unknown;
}

function rejection(code: string, message: string): FakeRpcResult {
  return { data: null, error: { code, message, details: "", hint: "" } };
}

/**
 * `resolve_or_create_end_customer`, as migration 0007 defines it.
 *
 * The behaviour that matters, and the reason this file is only ~30 lines of
 * logic: **an existing row is read, never written.** Not "fill the blanks", not
 * "replace if provided" — the returning-guest path performs no write at all, so
 * `name` and `phone` are immutable to it whatever the caller supplies.
 */
export function fakeResolveOrCreateEndCustomer(
  store: FakeIdentityStore,
  args: ResolveIdentityArgs,
): FakeRpcResult {
  const customerId = args.p_customer_id;

  // `end_customers.email` is `not null`; `lower(null)` is null, so the insert
  // in 0007 fails before it can conflict.
  if (typeof args.p_email !== "string") {
    return rejection(
      "23502",
      'null value in column "email" of relation "end_customers" violates not-null constraint',
    );
  }

  // `customer_id references customers (id)`. The function is SECURITY DEFINER,
  // which lets it write past RLS — it does not let it write past a foreign key.
  if (!store.customers.some((c) => c.id === customerId)) {
    return rejection(
      "23503",
      'insert or update on table "end_customers" violates foreign key constraint ' +
        '"end_customers_customer_id_fkey"',
    );
  }

  const email = args.p_email.toLowerCase();
  const existing = store.end_customers.find(
    (row) => row.customer_id === customerId && row.email === email,
  );

  // The fix, in one line: resolve and return, touching nothing.
  if (existing) return { data: existing.id, error: null };

  // First contact — and only here may the request set name/phone.
  const created: FakeEndCustomerRow = {
    id: `end-customer-${store.end_customers.length + 1}`,
    customer_id: customerId as string,
    email,
    name: typeof args.p_name === "string" ? args.p_name : "",
    phone: typeof args.p_phone === "string" ? args.p_phone : null,
  };
  store.end_customers.push(created);
  return { data: created.id, error: null };
}

/**
 * The conflict-semantics contract, as a table.
 *
 * Executed twice: against the model above (`guest-identity.test.ts`) and
 * against the real function on a live Postgres (`guest-identity.db.test.ts`).
 * Running one table through both is what keeps the fake honest — a case added
 * here has to hold in both worlds or CI fails.
 */
export interface IdentityConflictCase {
  label: string;
  /** The identity already on file, or `null` for first contact. */
  stored: { name: string; phone: string | null } | null;
  /** What the request supplies. */
  supplied: { name: string | null; phone: string | null };
  /** What the identity must hold **after** the call. */
  expected: { name: string; phone: string | null };
}

export const IDENTITY_CONFLICT_CASES: readonly IdentityConflictCase[] = [
  {
    // The live bug. Against 0003 this returned ('Bob', '+15550001').
    label: "existing identity, a different non-empty name is refused",
    stored: { name: "Alice", phone: "+15550001" },
    supplied: { name: "Bob", phone: null },
    expected: { name: "Alice", phone: "+15550001" },
  },
  {
    // The latent leg. No call site passes a phone today, so this is only
    // reachable by calling the function directly — which is exactly why it has
    // to be tested there rather than assumed unreachable.
    label: "existing identity, a different non-empty phone is refused",
    stored: { name: "Alice", phone: "+15550001" },
    supplied: { name: "Bob", phone: "+15559999" },
    expected: { name: "Alice", phone: "+15550001" },
  },
  {
    // Blank-to-populated is still a mutation, and is still out. This is the
    // case 0003's `nullif`/`coalesce` would have "helpfully" filled in.
    label: "existing identity with blank name/phone still refuses a supplied value",
    stored: { name: "", phone: null },
    supplied: { name: "Bob", phone: "+15559999" },
    expected: { name: "", phone: null },
  },
  {
    label: "existing identity, an empty incoming name changes nothing",
    stored: { name: "Alice", phone: "+15550001" },
    supplied: { name: "", phone: null },
    expected: { name: "Alice", phone: "+15550001" },
  },
  {
    label: "existing identity, a null incoming name changes nothing",
    stored: { name: "Alice", phone: "+15550001" },
    supplied: { name: null, phone: null },
    expected: { name: "Alice", phone: "+15550001" },
  },
  {
    label: "existing identity, the same name is a no-op",
    stored: { name: "Alice", phone: "+15550001" },
    supplied: { name: "Alice", phone: null },
    expected: { name: "Alice", phone: "+15550001" },
  },
  {
    // Not a regression case to tick off — the path that must keep working.
    label: "first contact creates the identity from the supplied values",
    stored: null,
    supplied: { name: "Bob", phone: "+15559999" },
    expected: { name: "Bob", phone: "+15559999" },
  },
  {
    label: "first contact with a null name stores the empty string",
    stored: null,
    supplied: { name: null, phone: null },
    expected: { name: "", phone: null },
  },
];
