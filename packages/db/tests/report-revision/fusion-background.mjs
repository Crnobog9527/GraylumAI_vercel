/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-BACKGROUND (0258): the advance lease (one advancer at a time, counted, released only by its holder), the
// daily kick marker (at most once a day per review) and the completion notice (own reviews only). No model call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {seed} from './cases.mjs';

async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
const settings = (db) => db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review:{enabled:true,reviewerModelIds:[],
  summaryModelId:null,skillId:null,maxRounds:2,opinionOutputTokens:4096,summaryOutputTokens:16384,maxBudgetUsd:'1',dispatchMinutes:10,
  breaker:{platformUsd:'2',noDeliveryCalls:10}},compare:{enabled:false}})]);

export async function runFusionBackground({db,Client,connectionString,report}) {
  const f = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);
  await settings(db);
  const rv = await service(db,'fusion_review_start',f.actor,randomUUID(),f.draft,f.versionId,{estimateUsd:'0.5',maxRounds:2});
  const lease = (token,ttl='5 minutes',max=30) => service(db,'fusion_review_advance_lease',rv.reviewId,token,ttl,max);
  const release = (token) => service(db,'fusion_review_advance_release',rv.reviewId,token);

  // One holder at a time; only the holder releases; an expired lease is taken over; every grant counts.
  const [a,b,c] = [randomUUID(),randomUUID(),randomUUID()];
  assert.deepEqual(await lease(a),{acquired:true,reason:'acquired',actorId:f.actor,count:1});
  assert.deepEqual(await lease(b),{acquired:false,reason:'leased',actorId:f.actor});
  assert.equal(await release(b),false,'another token cannot release it');
  assert.equal(await release(a),true);
  assert.equal((await lease(b)).acquired,true);
  await db.query(`UPDATE fusion_reviews SET advance_until=now()-interval '1 second' WHERE id=$1`,[rv.reviewId]);
  assert.deepEqual(await lease(c),{acquired:true,reason:'acquired',actorId:f.actor,count:3},'an expired lease is taken over');
  assert.equal(await release(b),false,'the expired holder cannot release the new lease');
  assert.equal(await release(c),true);
  // Past the limit nothing is granted again (a relay bug cannot run forever).
  assert.deepEqual(await lease(randomUUID(),'5 minutes',3),{acquired:false,reason:'limit',actorId:f.actor,count:3});
  for (const [ttl,max] of [['0 seconds',30],['11 minutes',30],['5 minutes',0]])
    await assert.rejects(lease(randomUUID(),ttl,max),/FUSION_REVIEW_INVALID/);
  // Concurrent takers on separate connections: exactly one wins, the other is refused at once (never waits).
  const clients = [new Client({connectionString}),new Client({connectionString})];
  try {
    for (const client of clients) { await client.connect(); await client.query("SET lock_timeout='5s'"); }
    const holder = new Client({connectionString}); await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM fusion_reviews WHERE id=$1 FOR UPDATE',[rv.reviewId]);
      const started = Date.now();
      assert.equal((await service(clients[0],'fusion_review_advance_lease',rv.reviewId,randomUUID(),'5 minutes',30)).reason,'busy');
      assert.ok(Date.now()-started<4000,'a held row refuses at once (NOWAIT)');
      await holder.query('ROLLBACK');
    } finally { await holder.end(); }
    const results = await Promise.all(clients.map(client =>
      service(client,'fusion_review_advance_lease',rv.reviewId,randomUUID(),'5 minutes',30)));
    assert.equal(results.filter(r => r.acquired).length,1,'two concurrent advancers: exactly one holds the lease');
  } finally { for (const client of clients) await client.end(); }
  await db.query('UPDATE fusion_reviews SET advance_token=NULL,advance_until=NULL WHERE id=$1',[rv.reviewId]);
  report.checks.push('0258: advance lease has one holder at a time, refuses a held row at once, is released only by its holder, is taken over when expired and stops past its limit');

  // Daily kick: idle running or paused reviews without a live lease, each at most once a day.
  await db.query(`UPDATE fusion_reviews SET updated_at=now()-interval '1 hour',advance_kicked_at=NULL WHERE id=$1`,[rv.reviewId]);
  const kicked = async () => {
    await db.query('SET ROLE service_role');
    try { return (await db.query(`SELECT review_id FROM fusion_review_kick_stalled('10 minutes',100)`)).rows.map(row => row.review_id); }
    finally { await db.query('RESET ROLE'); }
  };
  assert.ok((await kicked()).includes(rv.reviewId));
  assert.ok(!(await kicked()).includes(rv.reviewId),'not kicked twice in a day');
  await db.query(`UPDATE fusion_reviews SET advance_kicked_at=now()-interval '25 hours',advance_token=$2,advance_until=now()+interval '1 minute'
    WHERE id=$1`,[rv.reviewId,randomUUID()]);
  assert.ok(!(await kicked()).includes(rv.reviewId),'a live lease is not kicked');
  await db.query(`UPDATE fusion_reviews SET advance_token=NULL,advance_until=NULL,updated_at=now() WHERE id=$1`,[rv.reviewId]);
  assert.ok(!(await kicked()).includes(rv.reviewId),'a review that moved recently is not kicked');
  await assert.rejects(db.query(`SELECT * FROM fusion_review_kick_stalled('10 seconds',10)`),/FUSION_REVIEW_INVALID/);
  report.checks.push('0258: daily kick lists idle reviews without a live lease, each at most once a day');

  // Completion notice: own reviews only, "awaiting choice" until the choice is recorded, seen marked once.
  await db.query(`UPDATE fusion_reviews SET state='completed',outcome='{"kind":"revised"}',ended_at=now() WHERE id=$1`,[rv.reviewId]);
  assert.deepEqual((await lease(randomUUID())).reason,'ended','an ended review is never leased');
  const mine = await service(db,'fusion_review_mine',f.actor,10);
  const item = mine.find(r => r.reviewId===rv.reviewId);
  assert.ok(item && item.awaitingChoice===true && item.state==='completed' && item.outcomeKind==='revised' && item.seenAt===null);
  const other = await seed(db);
  assert.ok(!(await service(db,'fusion_review_mine',other.actor,10)).some(r => r.reviewId===rv.reviewId),'never another user\'s');
  await assert.rejects(service(db,'fusion_review_mark_seen',other.actor,rv.reviewId),/FUSION_REVIEW_DENIED/);
  assert.equal(await service(db,'fusion_review_mark_seen',f.actor,rv.reviewId),true);
  const first = (await service(db,'fusion_review_mine',f.actor,10)).find(r => r.reviewId===rv.reviewId).seenAt;
  assert.ok(first);
  await service(db,'fusion_review_mark_seen',f.actor,rv.reviewId);
  assert.equal((await service(db,'fusion_review_mine',f.actor,10)).find(r => r.reviewId===rv.reviewId).seenAt,first,'first time kept');
  await db.query(`UPDATE fusion_reviews SET adoption='{"state":"recorded"}' WHERE id=$1`,[rv.reviewId]);
  assert.equal((await service(db,'fusion_review_mine',f.actor,10)).find(r => r.reviewId===rv.reviewId).awaitingChoice,false);
  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    try {
      for (const [sql,args] of [['SELECT fusion_review_advance_lease($1,$2,$3,$4)',[rv.reviewId,randomUUID(),'5 minutes',30]],
        ['SELECT fusion_review_advance_release($1,$2)',[rv.reviewId,randomUUID()]],['SELECT * FROM fusion_review_kick_stalled($1,$2)',['10 minutes',10]],
        ['SELECT fusion_review_mine($1,$2)',[f.actor,10]],['SELECT fusion_review_mark_seen($1,$2)',[f.actor,rv.reviewId]]])
        await assert.rejects(db.query(sql,args),/permission denied/,role+' '+sql);
    } finally { await db.query('RESET ROLE'); }
  }
  report.checks.push('0258: completion notice lists own reviews only, awaiting choice until recorded, seen marked once; all five functions service role only');
}
