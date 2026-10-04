# Local migration replay

The billing migrations are **not self-contained**. They `ALTER` tables the
application created outside `supabase/migrations` (`plans`, `profiles`,
`webhook_events`, `usage_run_log`, `usage_meters`, `enterprise_credits`), so
`supabase db reset` fails on the first migration with:

```
ERROR: relation "public.plans" does not exist (SQLSTATE 42P01)
```

That makes them impossible to exercise before they are pushed to production,
which is how two silent regressions reached review in the first place. These
files replay the chain against a throwaway database instead.

Nothing here is ever applied to a real database — both files live outside
`../migrations` so `supabase db push` cannot send them anywhere.

## Replay

`supabase start` applies migrations on a fresh volume before you can seed
anything, so use a standalone Postgres instead:

```bash
docker run -d --name paqt-mig-test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p 54329:5432 postgres:17
```

The migrations grant/revoke against roles that only exist in a Supabase
database, so create them first:

```sql
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
```

Then seed the base schema and replay in filename order:

```bash
psql -f supabase/local-test/base_schema.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f" || break; done
```

## Verify

```bash
psql -f supabase/local-test/verify_polar_provider.sql
```

Every row prints `PASS`/`FAIL` and the last line says whether the migration is
safe to deploy. It is safe to re-run: the scratch rows are deleted first.

## What the checks guard

Three of these exist because the migration was wrong at review time:

| Check | Regression it catches |
| --- | --- |
| `live-slot index still frees ended subscriptions` | `00900` rebuilt `subscriptions_one_live_per_user` as `(provider, user_id)` but dropped the `razorpay_status` exclusion clause from `00400`. Five production users sit in `('canceling', 'cancelled')`; without the clause their ended row keeps holding the live slot, so re-subscribing through the same provider is rejected for the rest of the period they already paid for. |
| `paqt_billing_state still exposes the legacy razorpay keys` | `00900` renamed `last_razorpay_subscription_id` / `last_razorpay_customer_id` and dropped `last_status`. `create-checkout-session` and `subscription-manage` still read all three, so customers mid-cancellation would have had no provider id to act on. |
| `a customer holding an ended subscription can still buy from Polar` | Provider scoping of the index, which is what lets a Polar purchase through while a customer still holds a live Razorpay row. |

Note the two failure modes are independent: the `(provider, user_id)` scoping is
what unblocks *Polar* purchases, and the status clause is what unblocks
*same-provider* re-subscription. Fixing one does not fix the other.

## Known data inconsistency (not fixed here)

`plan_prices.unit_amount` is documented as minor units, but the Razorpay seed
copies `plans.price_amount`, which on production currently holds `2999` for
`individual` (rupees) rather than the `299900` paise that
`20260927000100_billing_core.sql` sets. Nothing charges from this column —
Razorpay bills from its own plan and Polar bills from its own product — so it
only affects display. Left alone rather than guessed at, since Razorpay amounts
are not ours to reinterpret while Razorpay is still deployed.
