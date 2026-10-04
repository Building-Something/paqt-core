// @vitest-environment node
/**
 * Customer-ownership tests.
 *
 * `createCustomer` asks Razorpay to return the existing customer for a known
 * email (`fail_existing: '0'`), and the stored id is reused whenever Razorpay
 * still recognises it. That makes the *email* the real identity: a stale
 * `notes.user_id` is normal after a re-registration and must be adopted, while a
 * customer on a different email is a genuine collision and must be refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateCustomer, RazorpayError } from './razorpay.ts';
import { createFakeAdmin, createFakeDb, installRazorpay, installFailingRazorpay } from '../test/harness.ts';

const USER = 'user-1';
const OTHER = 'user-2';

/** Notes written back by the code under test, per test. */
let patchedNotes: { id: string; notes: unknown }[] = [];

interface Profile {
  user_id: string;
  payment_customer_id: string | null;
}

/** A fake admin whose `profiles` table holds the given rows. */
function adminWithProfiles(rows: Profile[]) {
  const db = createFakeDb();
  const fake = createFakeAdmin(db);
  const find = (filters: Record<string, unknown>) =>
    rows.find((row) => Object.entries(filters).every(([k, v]) => (row as any)[k] === v));

  (fake as any).from = (table: string) => {
    if (table !== 'profiles') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    }
    let filters: Record<string, unknown> = {};
    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters = { ...filters, [column]: value };
        return builder;
      },
      maybeSingle: async () => ({ data: find(filters) ?? null, error: null }),
      // `update(...).eq(...)` resolves directly, so the write has to happen in
      // `eq`, not in a trailing `maybeSingle`.
      update: (values: Partial<Profile>) => ({
        eq: (column: string, value: unknown) => {
          Object.assign(find({ ...filters, [column]: value }) ?? {}, values);
          return Promise.resolve({ data: null, error: null });
        },
      }),
      upsert: (values: Partial<Profile>) => {
        const key = { user_id: values.user_id ?? filters.user_id };
        const target = find(key) ?? rows[0];
        if (target) {
          Object.assign(target, values);
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return builder;
  };
  return { db, admin: fake };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 15));
  patchedNotes = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Installs the harness and records any ownership re-stamp for assertions. */
function install(script: Parameters<typeof installRazorpay>[0]) {
  const harness = installRazorpay(script);
  patchedNotes = harness.patchedNotes;
  return harness;
}

describe('getOrCreateCustomer', () => {
  it('reuses a customer that belongs to this user', async () => {
    const { admin } = adminWithProfiles([
      { user_id: USER, payment_customer_id: 'cust_1' },
    ]);
    install({ customers: { cust_1: { id: 'cust_1', notes: { user_id: USER } } } });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).resolves.toBe('cust_1');
  });

  it('reuses a legacy customer that carries no ownership note', async () => {
    // Customers created before notes existed cannot be disproved, and refusing
    // them would orphan a paying customer's subscriptions.
    const { admin } = adminWithProfiles([
      { user_id: USER, payment_customer_id: 'cust_legacy' },
    ]);
    install({ customers: { cust_legacy: { id: 'cust_legacy', notes: {} } } });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).resolves.toBe('cust_legacy');
  });

  it('refuses a customer that belongs to a different Paqt user', async () => {
    const rows = [{ user_id: USER, payment_customer_id: 'cust_other' }];
    const { admin } = adminWithProfiles(rows);
    // A *different email* is the only genuine collision: linking it would let
    // reconciliation hand one account the plan the other paid for.
    install({
      customers: { cust_other: { id: 'cust_other', email: 'other@b.test', notes: { user_id: OTHER } } },
      createdCustomer: { id: 'cust_foreign', email: 'other@b.test', notes: { user_id: OTHER } },
    });

    const error = await getOrCreateCustomer(admin, USER, 'a@b.test', 'A').catch((err) => err);

    expect(error).toBeInstanceOf(RazorpayError);
    expect(error.code).toBe('customer_conflict');
    expect(rows[0].payment_customer_id).toBe('cust_other');
  });

  it('adopts a stale customer when the same email re-registered', async () => {
    // Deleting a Supabase auth row and signing up again issues a new user id for
    // the same person, but `fail_existing` keeps returning the same customer.
    // Refusing here would lock that person out of checkout forever.
    const rows = [{ user_id: USER, payment_customer_id: 'cust_stale_note' }];
    const { admin } = adminWithProfiles(rows);
    install({
      customers: {
        cust_stale_note: { id: 'cust_stale_note', email: 'a@b.test', notes: { user_id: OTHER } },
      },
    });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).resolves.toBe('cust_stale_note');
    expect(rows[0].payment_customer_id).toBe('cust_stale_note');
    expect(patchedNotes).toEqual([{ id: 'cust_stale_note', notes: { user_id: USER } }]);
  });

  it('treats a matching email as ours even when the note is missing', async () => {
    const rows = [{ user_id: USER, payment_customer_id: null }];
    const { admin } = adminWithProfiles(rows);
    // `fail_existing` returned an existing customer for this email; its email is
    // what identifies the account, not the note it happens to carry.
    install({
      createdCustomer: { id: 'cust_by_email', email: 'a@b.test', notes: { user_id: OTHER } },
    });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).resolves.toBe('cust_by_email');
    expect(rows[0].payment_customer_id).toBe('cust_by_email');
    expect(patchedNotes).toEqual([{ id: 'cust_by_email', notes: { user_id: USER } }]);
  });

  it('recognises the legacy paqt_user_id note key', async () => {
    const rows = [{ user_id: USER, payment_customer_id: 'cust_legacy_key' }];
    const { admin } = adminWithProfiles(rows);
    install({
      customers: {
        cust_legacy_key: {
          id: 'cust_legacy_key',
          email: 'someone@else.test',
          notes: { paqt_user_id: OTHER },
        },
      },
      createdCustomer: { id: 'x', email: 'someone@else.test', notes: { paqt_user_id: OTHER } },
    });

    // Ownership is recorded under `paqt_user_id` here, so the note must not be
    // mistaken for a missing one and adopted.
    const error = await getOrCreateCustomer(admin, USER, 'a@b.test', 'A').catch((err) => err);
    expect(error).toBeInstanceOf(RazorpayError);
    expect(error.code).toBe('customer_conflict');
  });

  it('does not link a customer that came back owned by somebody else', async () => {
    const rows: Profile[] = [{ user_id: USER, payment_customer_id: null }];
    const { admin } = adminWithProfiles(rows);
    install({
      createdCustomer: { id: 'cust_contaminated', email: 'other@b.test', notes: { user_id: OTHER } },
    });

    const error = await getOrCreateCustomer(admin, USER, 'a@b.test', 'A').catch((err) => err);

    expect(error).toBeInstanceOf(RazorpayError);
    expect(error.providerDescription).toMatch(/different account/);
    expect(rows[0].payment_customer_id).toBeNull();
  });

  it('links a freshly created customer to the profile', async () => {
    const rows: Profile[] = [{ user_id: USER, payment_customer_id: null }];
    const { admin } = adminWithProfiles(rows);
    install({ createdCustomer: { id: 'cust_new', notes: { user_id: USER } } });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).resolves.toBe('cust_new');
    expect(rows[0].payment_customer_id).toBe('cust_new');
  });

  it('drops a stored customer the provider no longer recognises', async () => {
    // A key rotated between test and live mode leaves a stale id that every
    // later checkout would otherwise fail on.
    const rows = [{ user_id: USER, payment_customer_id: 'cust_stale' }];
    const { admin } = adminWithProfiles(rows);
    install({ missing: ['cust_stale'] });

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).rejects.toBeInstanceOf(RazorpayError);
    expect(rows[0].payment_customer_id).toBeNull();
  });

  it('surfaces a provider outage rather than inventing a customer', async () => {
    const rows: Profile[] = [{ user_id: USER, payment_customer_id: null }];
    const { admin } = adminWithProfiles(rows);
    installFailingRazorpay(500);

    await expect(getOrCreateCustomer(admin, USER, 'a@b.test', 'A')).rejects.toBeInstanceOf(RazorpayError);
    expect(rows[0].payment_customer_id).toBeNull();
  });
});
