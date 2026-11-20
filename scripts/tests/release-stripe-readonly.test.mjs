/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createStripeReadonly } from '../e2e-sim/stripe-readonly.mjs';

test('local Stripe double permits only account and balance reads', async t => {
  const server = createStripeReadonly();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/account`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/balance`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/checkout/sessions`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${origin}/v1/customers`)).status, 403);
});

test('the real Stripe SDK gets the local synthetic scope while sockets remain loopback only', async t => {
  const server = createStripeReadonly();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const source = `const Stripe = require('stripe'); const s = new Stripe('sk_test_synthetic', {maxNetworkRetries:0});
    Promise.all([s.accounts.retrieveCurrent(),s.balance.retrieve()]).then(([a,b])=>{
      if(a.id!=='acct_rehearsal'||b.livemode!==false) process.exit(2);
      return s.checkout.sessions.create({mode:'payment',success_url:'http://127.0.0.1/success'})
        .then(()=>process.exit(4), error=>{if(error.statusCode!==403) process.exit(5)});
    }).catch(()=>process.exit(3));`;
  const child = spawn(process.execPath, ['--require', resolve('scripts/e2e-sim/release-network.cjs'),
    '--require', resolve('scripts/e2e-sim/stripe-readonly-preload.cjs'), '-e', source], {
    cwd: resolve('packages/api'), env: { PATH: process.env.PATH, SIM_STRIPE_ORIGIN: `http://127.0.0.1:${server.address().port}` },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  assert.equal(await new Promise(ok => child.once('exit', ok)), 0);
});
