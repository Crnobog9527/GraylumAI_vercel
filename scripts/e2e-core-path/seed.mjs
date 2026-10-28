#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Creates or refreshes the dedicated staging accounts of the core-path e2e journeys (apps/web/tests/e2e/core-path).
// Safe to run again and again. It writes credentials ONLY to the file named by --out (mode 0600), never to stdout.
//
//   E2E_SEED_SUPABASE_URL=https://<staging-ref>.supabase.co E2E_SEED_SERVICE_ROLE_KEY=... CORE_E2E_EMAIL_DOMAIN=... \
//     node scripts/e2e-core-path/seed.mjs --out ~/.graylum/secrets/core-e2e-accounts.json
//
// Refuses any target but the staging project. Needs the staging service-role key, so the controller runs it (or the CI job
// that holds the secret).
import { chmod, writeFile } from 'node:fs/promises';

import { createClient } from '@supabase/supabase-js';

import { ACCOUNTS, assertStagingUrl, emailFor, randomPassword, topUpAmount } from './seed-lib.mjs';

function outPath(argv) {
  const index = argv.indexOf('--out');
  if (index === -1 || !argv[index + 1]) throw new Error('Pass --out <file> for the credentials file.');
  return argv[index + 1];
}

async function findUser(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error('Could not list users.');
    const hit = data.users.find(user => user.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main(argv) {
  const url = assertStagingUrl(process.env.E2E_SEED_SUPABASE_URL ?? '');
  const key = process.env.E2E_SEED_SERVICE_ROLE_KEY;
  if (!key) throw new Error('E2E_SEED_SERVICE_ROLE_KEY is not set.');
  const domain = process.env.CORE_E2E_EMAIL_DOMAIN ?? '';
  const out = outPath(argv);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = {};

  for (const [role, plan] of Object.entries(ACCOUNTS)) {
    const email = emailFor(role, domain);
    const password = randomPassword();
    let user = await findUser(admin, email);
    if (!user) {
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error(`Could not create the ${role} account.`);
      user = created.data.user;
    } else {
      const updated = await admin.auth.admin.updateUserById(user.id, { password, ban_duration: 'none', email_confirm: true });
      if (updated.error) throw new Error(`Could not refresh the ${role} account.`);
    }
    // The profile row is created by the signup trigger; wait for it, then set plan and credits.
    let profile = null;
    for (let attempt = 0; attempt < 20 && !profile; attempt += 1) {
      const read = await admin.from('profiles').select('id,credits').eq('id', user.id).maybeSingle();
      if (read.data) profile = read.data;
      else await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!profile) throw new Error(`The ${role} profile did not appear.`);
    const update = await admin.from('profiles')
      .update({ membership_level: plan.level, credits: Math.max(Number(profile.credits ?? 0), plan.credits) })
      .eq('id', user.id);
    if (update.error) throw new Error(`Could not set the ${role} plan and credits (${topUpAmount(profile.credits, plan.credits)} to add).`);
    result[role] = { email, password };
    console.log(`${role}: ready (${plan.level}, at least ${plan.credits} credits)`);
  }

  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`Credentials written to ${out} (not printed).`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
