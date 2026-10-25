/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE auto-continue after a reload (0394 on 0263): research_user_unfinished_round gives the page back the
// discovery round that ran out of its reply's lookups, only while it is truly waiting for its next reply. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

export async function unfinishedRoundCases({db,check,rpc,seed,answer}) {
  /** A discovery of the session, running, whose cursor says which reply stopped it and which replies it took. */
  async function discovery(f,e,cursor) {
    const card = randomUUID(), tag = card.slice(0,6);
    await rpc(db,'research_card_create',f.actor,card,f.session,e,{kind:'keywords',
      options:[{id:'k0',text:`抽纱 ${tag}`},{id:'k1',text:`刺绣 ${tag}`},{id:'k2',text:`针法 ${tag}`}]});
    const confirmed = await rpc(db,'research_card_confirm',f.actor,card,{selected:['k0','k1','k2']});
    const d = (await rpc(db,'research_discovery_start',f.actor,f.session,e,confirmed.confirmationId,['tiktok'])).discoveryId;
    if (cursor) await rpc(db,'research_discovery_save',f.actor,f.session,d,cursor,'running');
    return d;
  }
  const reply = async (f,{state='completed',result={completeness:'complete'},age}={}) => {
    const id = randomUUID();
    await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
      VALUES($1,$2,$3,gen_random_uuid(),'{}',0,$4,$5::jsonb)`,[id,f.actor,f.session,state,JSON.stringify(result)]);
    // Older as a whole: the fixture's own executions move back with it, so this reply stays the session's latest.
    if (age) await db.query('UPDATE runtime_executions SET created_at=created_at-$2::interval WHERE session_id=$1',[f.session,age]);
    return id;
  };
  const round = f => rpc(db,'research_user_unfinished_round',f.actor,f.session);

  await check('UNFINISHED ROUND a round waiting on its latest, normally completed reply is given back with the replies it took', async () => {
    const f = await seed(db), e1 = await reply(f), e2 = await reply(f);
    const d = await discovery(f,e1,{accounts:[],executions:[e1,e2],continueFrom:e2});
    assert.deepEqual(await round(f),{discoveryId:d,executionId:e2,replies:2});
    // No cursor marker yet (a round written before this change): nothing to give back, never an error.
    const g = await seed(db), ge = await reply(g);
    await discovery(g,ge,{accounts:[]});
    assert.equal(await round(g),null);
    // A session without any discovery.
    assert.equal(await round(await seed(db)),null);
  });

  await check('UNFINISHED ROUND not once anything else happened: a later message, a stop, a pause, a finished round or time', async () => {
    const f = await seed(db), e1 = await reply(f), d = await discovery(f,e1,{executions:[e1],continueFrom:e1});
    assert.equal((await round(f)).executionId,e1);
    // The user (or the continuation itself) sent a later message: the wait is over.
    const later = await reply(f);
    assert.equal(await round(f),null);
    await db.query('DELETE FROM runtime_executions WHERE id=$1',[later]);
    assert.equal((await round(f)).executionId,e1);
    // The round ended: nothing waits.
    await rpc(db,'research_discovery_save',f.actor,f.session,d,{executions:[e1],continueFrom:e1},'completed');
    assert.equal(await round(f),null);
    // The reply the user stopped, a paused or cancelled one, one whose content was deleted, and an old one.
    const cases = [
      ['stopped by the user (completeness)',{result:{completeness:'stopped'}}],
      ['stopped by the user (flag)',{result:{stopped:true}}],
      ['paused for credits',{state:'waiting_credits'}],
      ['cancelled',{state:'cancelled'}],
      ['older than 30 minutes',{age:'31 minutes'}],
    ];
    for (const [name,options] of cases) {
      const g = await seed(db), ge = await reply(g,options);
      await discovery(g,ge,{executions:[ge],continueFrom:ge});
      assert.equal(await round(g),null,name);
    }
    const h = await seed(db), he = await reply(h,{age:'29 minutes'});
    await discovery(h,he,{executions:[he],continueFrom:he});
    assert.equal((await round(h)).executionId,he,'29 minutes old still counts');
    // The erasure guard refuses a direct write: this fixture steps around it (local superuser only) to mark the content deleted.
    await db.query('BEGIN');
    await db.query("SET LOCAL session_replication_role='replica'");
    await db.query('UPDATE runtime_executions SET content_deleted_at=now() WHERE id=$1',[he]);
    await db.query('COMMIT');
    assert.equal(await round(h),null,'deleted content');
  });

  await check('UNFINISHED ROUND only the latest discovery, only the owner, and a marker that names no reply of the session gives nothing', async () => {
    const f = await seed(db), e1 = await reply(f), old = await discovery(f,e1,{executions:[e1],continueFrom:e1});
    assert.equal((await round(f)).discoveryId,old);
    // A newer discovery that is not waiting hides the older one.
    const e2 = await reply(f);
    await discovery(f,e2,{accounts:[]});
    assert.equal(await round(f),null);
    // A marker pointing at another session's reply, at nothing, or at garbage.
    const g = await seed(db), ge = await reply(g), other = await seed(db), foreign = await reply(other);
    for (const marker of [foreign,randomUUID(),'not-a-uuid',42]) {
      const h = await seed(db), he = await reply(h);
      await discovery(h,he,{executions:[he],continueFrom:marker});
      assert.equal(await round(h),null,String(marker));
    }
    // Another actor can neither read nor learn about this session.
    await assert.rejects(rpc(db,'research_user_unfinished_round',other.actor,f.session),/RESEARCH_SCOPE_DENIED|permission|not/i);
    void ge;
  });

  await check('UNFINISHED ROUND service_role only; the migration is repeatable', async () => {
    const grants = (await db.query(`SELECT has_function_privilege('anon',f,'EXECUTE') anon, has_function_privilege('authenticated',f,'EXECUTE') auth,
      has_function_privilege('service_role',f,'EXECUTE') service FROM (SELECT 'public.research_user_unfinished_round(uuid,uuid)'::regprocedure f) x`)).rows[0];
    assert.deepEqual(grants,{anon:false,auth:false,service:true});
    const migration = readFileSync(new URL('../../migrations/0394_research_unfinished_round.sql',import.meta.url),'utf8');
    const definition = async () => (await db.query("SELECT pg_get_functiondef('public.research_user_unfinished_round(uuid,uuid)'::regprocedure) d")).rows[0].d;
    const before = await definition();
    await db.query(migration);
    assert.equal(await definition(),before);
  });
}
