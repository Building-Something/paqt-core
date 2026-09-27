#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PLANS = [
  { id: 'individual', name: 'Paqt — Individual', amount: 299900 },
  { id: 'pro', name: 'Paqt — Pro', amount: 599900 },
];

function loadEnv() {
  const values = {};
  const file = resolve(ROOT, '.billing-env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values[key] = value;
  }
  return values;
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

async function razorpayAuthed(env) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    fail('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required (test keys rzp_test_... are fine to start).');
  }
  const token = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  async function call(path, options = {}) {
    const response = await fetch(`https://api.razorpay.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(`Razorpay ${options.method || 'GET'} ${path} failed (${response.status}): ${json.error?.description || JSON.stringify(json)}`);
    }
    return json;
  }
  return call;
}

async function ensurePlans(call) {
  const plans = [];
  for (const plan of PLANS) {
    const existing = await call('/plans?period=monthly&count=100');
    const match = (existing.items ?? []).find(
      (item) => item.period === 'monthly' && item.item?.currency === 'INR' && Number(item.item?.amount) === plan.amount,
    );
    if (match) {
      console.log(`• ${plan.id}: reusing ${match.id} (${plan.name}, ₹${plan.amount / 100})`);
      plans.push({ id: plan.id, planId: match.id });
      continue;
    }
    const created = await call('/plans', {
      method: 'POST',
      body: JSON.stringify({
        period: 'monthly',
        interval: 1,
        item: {
          name: plan.name,
          amount: plan.amount,
          currency: 'INR',
          description: `Paqt ${plan.id} plan — monthly subscription`,
        },
      }),
    });
    console.log(`• ${plan.id}: created ${created.id} (${plan.name}, ₹${plan.amount / 100})`);
    plans.push({ id: plan.id, planId: created.id });
  }
  return plans;
}

function writePriceIdSql(plans) {
  const sql = plans
    .map((plan) => `update public.plans set price_id = '${plan.planId}' where id = '${plan.id}';`)
    .join('\n');
  const file = resolve(ROOT, 'supabase', 'set-plan-price-ids.sql');
  writeFileSync(file, `${sql}\n`);
  console.log(`• wrote ${file}`);
}

function supabaseBin() {
  const which = spawnSync('where.exe', ['supabase'], { encoding: 'utf8' });
  if (which.status === 0 && (which.stdout ?? '').trim()) return 'supabase';
  const npx = spawnSync('where.exe', ['npx'], { encoding: 'utf8' });
  if (npx.status === 0) return 'npx --yes supabase@latest';
  fail('Neither the supabase CLI nor npx is available.');
}

async function deploySupabase(env, plans) {
  if (!env.SUPABASE_ACCESS_TOKEN) {
    console.log('• SUPABASE_ACCESS_TOKEN not set — skipping schema/secrets/function deployment.');
    console.log('  Provide it to run: link, secrets set, and functions deploy automatically.');
    return;
  }
  if (!env.SUPABASE_PROJECT_REF) {
    fail('SUPABASE_PROJECT_REF is required when SUPABASE_ACCESS_TOKEN is set (from Project Settings > General).');
  }

  const bin = supabaseBin().split(' ');
  const childEnv = { ...process.env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN };

  function run(args, expectExit = 0) {
    console.log(`\n$ supabase ${args.join(' ')}`);
    const result = spawnSync(bin[0], [...bin.slice(1), ...args], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
      encoding: 'utf8',
    });
    if (result.status !== expectExit && result.status !== null) {
      fail(`supabase ${args[0]} exited with ${result.status}.`);
    }
    return result;
  }

  run(['link', '--project-ref', env.SUPABASE_PROJECT_REF]);

  const secrets = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
  run(['secrets', 'set', ...secrets.flatMap((key) => [key, env[key]])]);

  run(['functions', 'deploy', 'create-checkout-session', '--no-verify-jwt']);
  run(['functions', 'deploy', 'subscription-manage', '--no-verify-jwt']);
  run(['functions', 'deploy', 'razorpay-webhook', '--no-verify-jwt']);
}

async function main() {
  const env = loadEnv();
  const call = await razorpayAuthed(env);
  const plans = await ensurePlans(call);
  writePriceIdSql(plans);

  await deploySupabase(env);

  console.log('\nDone. Remaining manual steps:');
  console.log('  1. Apply supabase/schema.sql in the Dashboard SQL editor (needs only browser login).');
  console.log('  2. Run supabase/set-plan-price-ids.sql in the Dashboard SQL editor.');
  console.log(`  3. Register the webhook in Razorpay Dashboard → Settings → Webhooks:`);
  console.log(`     URL: https://${env.SUPABASE_PROJECT_REF || '<project-ref>'}.supabase.co/functions/v1/razorpay-webhook`);
  console.log('     Secret: RAZORPAY_WEBHOOK_SECRET. Events: subscription.activated, subscription.charged,');
  console.log('     subscription.resumed, subscription.updated, subscription.pending, subscription.completed,');
  console.log('     subscription.cancelled, subscription.paused, subscription.halted, payment.authorized,');
  console.log('     payment.captured, payment.failed, payment.refunded, refund.processed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});