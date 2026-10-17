/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Account erasure: the wall disappears at once, both tables are pruned, the consent audit is kept. */
export async function founderErasureCases({ v, code, ok, fx, now, day }) {
  const admin = await fx.profile('admin');
  const member = await fx.profile(), bystander = await fx.profile();
  for (const a of [member, bystander]) {
    await fx.order(a, { method: 'alipay', start: now - 5 * day, end: now + 360 * day });
    await v('SELECT founder_wall_submit($1,$2,$3) v', [a, JSON.stringify({ displayName: `M${a.slice(0, 4)}` }), 'fw-v1']);
    const seen = await v('SELECT updated_at::text v FROM founder_wall_entries WHERE user_id=$1', [a]);
    await v('SELECT founder_wall_review($1,$2,$3,$4) v', [admin, a, 'approved', seen]);
    await v("SELECT founder_community_mark($1,$2,'joined') v", [admin, a]);
  }
  const listed = async () => (await v('SELECT founder_wall_public() v')).length;
  assert.equal(await listed(), 2);
  const remaining = a => v('SELECT account_erasure_business_remaining($1)::int v', [a]);
  assert.ok(await remaining(member) >= 2);

  await v('SELECT account_erasure_confirm($1,$2) v', [member, randomUUID()]);
  // Measured after closing: other leaves (e.g. the library storage proof) also count once a request exists.
  const before = await remaining(member);
  assert.equal(await listed(), 1, 'a closing account leaves the wall in the confirming transaction');
  assert.equal(await v("SELECT revoke_reason v FROM data_use_consents WHERE profile_id=$1 AND purpose='founder_wall'"
    + ' ORDER BY granted_at DESC LIMIT 1', [member]), 'account_erasure');
  await code(v('SELECT founder_wall_submit($1,$2,$3) v', [member, JSON.stringify({ displayName: 'X' }), 'fw-v1']), '42501');
  await code(v("SELECT founder_community_mark($1,$2,'joined') v", [admin, member]), '42501');

  await v('SELECT account_erasure_prune_business($1,100) v', [member]);
  assert.equal(await v('SELECT count(*)::int v FROM founder_wall_entries WHERE user_id=$1', [member]), 0);
  assert.equal(await v('SELECT count(*)::int v FROM founder_community_status WHERE user_id=$1', [member]), 0);
  assert.equal(await remaining(member), before - 2, 'both rows were counted as remaining work and are now gone');
  assert.equal(await v('SELECT count(*)::int v FROM founder_wall_entries WHERE user_id=$1', [bystander]), 1);
  assert.equal(await v('SELECT count(*)::int v FROM founder_community_status WHERE user_id=$1', [bystander]), 1);
  assert.equal(await v("SELECT count(*)::int v FROM data_use_consents WHERE profile_id=$1 AND purpose='founder_wall'", [member]), 1,
    'the content-free consent audit stays for its one-year retention');
  ok('erasure: wall hidden immediately, consent revoked, wall and community rows pruned, other members untouched');
}
