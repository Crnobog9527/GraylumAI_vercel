/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { inventory, processOrder } from './legacy-checkout/database.mjs';
const requireApi = createRequire(new URL('../packages/api/package.json', import.meta.url));

export function parseOptions(args, env) {
  const allowed = new Set(['--target', '--order-id', '--apply', '--approved-read', '--approved-close']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag) || flag in options) throw new Error('INVALID_OPTIONS');
    if (['--target', '--order-id'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('INVALID_OPTIONS');
      options[flag] = value;
    } else options[flag] = true;
  }
  const target = options['--target'];
  const mode = target === 'staging' ? 'test' : target === 'production' ? 'live' : null;
  const apply = options['--apply'] === true;
  const orderId = options['--order-id'];
  if (!mode || !options['--approved-read'] || (apply && (!options['--approved-close'] || !orderId))
    || (orderId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId))) {
    throw new Error('EXPLICIT_SCOPE_AND_APPROVAL_REQUIRED');
  }
  const connectionString = env.LEGACY_CLEANUP_DATABASE_URL;
  const key = env.LEGACY_CLEANUP_STRIPE_KEY;
  const merchant = env.LEGACY_CLEANUP_STRIPE_ACCOUNT;
  if (!connectionString || !/^postgres(ql)?:\/\//.test(connectionString)
    || !key?.startsWith(`rk_${mode}_`) || !/^acct_[A-Za-z0-9]+$/.test(merchant ?? '')) {
    throw new Error('EXPLICIT_DATABASE_AND_READ_ONLY_STRIPE_CREDENTIALS_REQUIRED');
  }
  return { target, scope: { mode, merchant }, apply, orderId, connectionString, key };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args, env);
  const Stripe = requireApi('stripe');
  const stripe = new Stripe(options.key, { maxNetworkRetries: 0, timeout: 10000 });
  // A restricted Stripe key with read-only permissions is required. Do not print it or account details.
  const account = await stripe.accounts.retrieve();
  if (account.object !== 'account' || account.id !== options.scope.merchant) throw new Error('PROVIDER_SCOPE_MISMATCH');
  const db = new pg.Client({ connectionString: options.connectionString, connectionTimeoutMillis: 10000,
    statement_timeout: 30000, application_name: 'legacy-checkout-cleanup' });
  await db.connect();
  try {
    const orders = await inventory(db, options.orderId);
    if (options.orderId && orders.length !== 1) throw new Error('ORDER_NOT_FOUND');
    const results = [];
    for (const order of orders) results.push(await processOrder({ db, stripe, order, ...options }));
    console.log(JSON.stringify({ target: options.target, mode: options.scope.mode,
      operation: options.apply ? 'close-one' : 'read-only', complete: true, results }, null, 2));
    if (results.some(row => row.outcome === 'unresolved')) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('LEGACY_CLEANUP_FAILED: no automatic retry; inspect private remote state before another close.');
    process.exitCode = 1;
  });
}
