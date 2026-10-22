/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {POSTGRES_IMAGE} from '../v3/images.mjs';
import {buildFromFiles,installPgCronStub} from '../baseline/build-from-files.mjs';
import { walletMembershipCases } from '../pay-waffo/wallet-membership.mjs';
import {stripeMpUpgradeCases} from '../pay-waffo/stripe-mp-upgrade.mjs';
import {stripeTestClockCases} from '../pay-waffo/stripe-test-clock.mjs';

assert.ok(process.argv[2]==='--local-only'&&!process.env.CI || process.argv[2]==='--ci'&&process.env.CI,
  'use --local-only locally or --ci in CI; only an isolated local database is supported');
const root=resolve(import.meta.dirname,'../../../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const laterMigrations=number=>readdirSync(resolve(root,'packages/db/migrations'))
  .filter(file=>/^\d{4}_.*\.sql$/.test(file)&&Number(file.slice(0,4))>number).sort();
const run=(args,input)=>{
  const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
  if(r.status!==0||r.error) throw Error(r.stderr||String(r.error));
  return r.stdout.trim();
};
const endpoint=run(['context','inspect','--format','{{.Endpoints.docker.Host}}']);
assert.match(endpoint,/^unix:\/\//);
const docker=(args,input)=>run(['--host',endpoint,...args],input);
docker(['image','inspect',POSTGRES_IMAGE]);
const name='graylum-upgrade-'+randomUUID().slice(0,8);
const sql=input=>docker(['exec','-i',name,'psql','-XqAt','-U','postgres','-d','upgrade',
  '-v','ON_ERROR_STOP=1','-f','/dev/stdin'],input);
const clients=[];
try {
  docker(['run','-d','--pull=never','--name',name,'-e','POSTGRES_DB=upgrade','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-p','127.0.0.1::5432',POSTGRES_IMAGE]);
  let ready=false;
  for(let i=0;i<100&&!ready;i++) {
    try {sql('SELECT 1');ready=true;} catch {await new Promise(r=>setTimeout(r,100));}
  }
  assert.ok(ready);
  installPgCronStub(root,name,(args,input)=>docker(['exec',...args],input));
  const apply=input=>{try {sql(input);return {ok:true};} catch(e) {return {ok:false,error:e.message};}};
  const signatures=['public.atomic_pre_deduct(uuid,integer,text,uuid)',
    'public.bill2_payg_compensate(bill2_runs,bill2_calls)','public.opc_start_b1(uuid,uuid,text,text,uuid,text,text)'];
  const objects=()=>JSON.parse(sql(read('packages/db/tests/baseline/fingerprint.sql')));
  const functionCatalogKeys=catalog=>signatures.flatMap(signature=>{
    const identity=signature.replace(/^public\./,'').replace(/\s/g,'');
    return ['fn','fnacl'].map(prefix=>{
      const matches=Object.keys(catalog).filter(key=>key.startsWith(`${prefix}:`)
        &&key.slice(prefix.length+1).replace(/^public\./,'').replace(/\s/g,'')===identity);
      assert.equal(matches.length,1,`fingerprint contains exactly one ${prefix} entry for ${signature}`);
      return matches[0];
    });
  });
  let before,after,originals,originalFunctionKeys,originalFunctionEntries;
  let walletOriginals,walletBefore,walletChangedKeys;
  const walletMigration='packages/db/migrations/0330_pay_wallet_membership_projection.sql';
  const build=buildFromFiles(root,{applyFile:path=>{
    const migration=read(path);
    if(path===walletMigration) {
      walletBefore=objects();
      walletOriginals=['public.pay_common_membership_facts(uuid)',
        'public.pay_waffo_observe_qualification(uuid,text,text,text,text,text,integer,text,timestamptz)',
        'public.pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb,text,uuid)',
        'public.pay_waffo_fulfill_payment(uuid,text,text,text,integer,text,timestamptz,text,timestamptz,timestamptz)',
        'public.pay_waffo_release_due(integer)',
        'public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)']
        .map(sig=>sql(`SELECT pg_get_functiondef('${sig}'::regprocedure);`));
      const interrupted=apply(migration.replace(/COMMIT;\s*$/,
        "DO $$ BEGIN RAISE EXCEPTION 'WALLET_ROLLBACK_PROBE'; END $$; COMMIT;"));
      assert.equal(interrupted.ok,false); assert.match(interrupted.error,/WALLET_ROLLBACK_PROBE/);
      assert.deepEqual(objects(),walletBefore,'wallet interrupted migration preserves schema and ACL');
      const applied=apply(migration);
      if(!applied.ok) return applied;
      const current=objects();
      walletChangedKeys=Object.keys(current).filter(key=>current[key]!==walletBefore[key]);
      assert.equal(walletChangedKeys.length,7,'wallet migration changes six function bodies and one transition constraint');
      assert.ok(walletChangedKeys.every(key=>key.startsWith('fn:')||key==='con:payment_orders'),
        'wallet migration never changes ACL or other schema');
      sql(migration);
      assert.deepEqual(objects(),current,'wallet second application preserves schema and ACL');
      return applied;
    }
    if(path.endsWith('0331_pay_stripe_card_cn_test_clock.sql')) {
      const previous=objects();
      const interrupted=apply(migration.replace(/COMMIT;\s*$/,"DO $$ BEGIN RAISE EXCEPTION 'CN_CLOCK_ROLLBACK_PROBE'; END $$; COMMIT;"));
      assert.equal(interrupted.ok,false);assert.match(interrupted.error,/CN_CLOCK_ROLLBACK_PROBE/);
      assert.deepEqual(objects(),previous,'0331 interruption preserves schema and ACL');
      const applied=apply(migration);if(!applied.ok)return applied;
      const current=objects(),changed=Object.keys(current).filter(key=>current[key]!==previous[key]);
      assert.equal(changed.length,3,'0331 changes two time predicates and preserves MP-only close explicitly');
      assert.ok(changed.every(key=>key.startsWith('fn:pay_stripe_test_clock_time(')
        ||key.startsWith('fn:pay_stripe_test_clock_observe(')
        ||key.startsWith('fn:pay_stripe_test_clock_close_refunded(')),'0331 preserves all ACL and other functions');
      sql(migration);assert.deepEqual(objects(),current,'0331 repeat preserves definitions and ACL');
      return applied;
    }
    if(path.endsWith('0329_pay_stripe_test_clock.sql')) {
      const beforeClock=objects();
      const failed=apply(migration.replace(/COMMIT;\s*$/,"DO $$ BEGIN RAISE EXCEPTION 'CLOCK_ROLLBACK_PROBE'; END $$; COMMIT;"));
      assert.equal(failed.ok,false);assert.match(failed.error,/CLOCK_ROLLBACK_PROBE/);
      assert.deepEqual(objects(),beforeClock,'0329 interruption leaves the old schema and ACL intact');
      const applied=apply(migration);if(!applied.ok)return applied;
      const afterClock=objects();sql(migration);
      assert.deepEqual(objects(),afterClock,'0329 repeat preserves definitions and ACL');
      return applied;
    }
    if(!path.endsWith('_pay_stripe_mp_upgrade_overlap.sql')) return apply(migration);
    before=objects();
    originalFunctionKeys=functionCatalogKeys(before);
    originalFunctionEntries=Object.fromEntries(originalFunctionKeys.map(key=>[key,before[key]]));
    originals=signatures.map(sig=>sql(`SELECT pg_get_functiondef('${sig}'::regprocedure);`));
    const failed=apply(migration.replace(/COMMIT;\s*$/,"DO $$ BEGIN RAISE EXCEPTION 'UPGRADE_ROLLBACK_PROBE'; END $$; COMMIT;"));
    assert.equal(failed.ok,false);
    assert.match(failed.error,/UPGRADE_ROLLBACK_PROBE/);
    assert.deepEqual(objects(),before,'interrupted migration leaves all definitions/ACL unchanged');
    const applied=apply(migration);
    if(!applied.ok) return applied;
    after=objects();
    sql(migration);
    assert.deepEqual(objects(),after,'second application preserves structure and ACL');
    return applied;
  },applyServerOnly:apply});
  assert.equal(build.failed,null,JSON.stringify(build.failed));
  assert.ok(before&&after&&originals&&originalFunctionKeys&&originalFunctionEntries,
    'upgrade migration was tested at its actual historical position');
  const finalCatalog=objects();
  const port=Number(docker(['port',name,'5432/tcp']).split(':').at(-1));
  const connect=async()=>{
    const db=new pg.Client({host:'127.0.0.1',port,database:'upgrade',user:'postgres',statement_timeout:15000});
    clients.push(db);await db.connect();return db;
  };
  const admin=await connect(),service=await connect();
  await service.query('SET ROLE service_role');
  for(const [level,monthly,annual,credits] of [['free',0,0,0],['pro',2900,27900,3480],['gold',6900,62100,8970]]) {
    await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
      allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES($1,$1,$2,$3,$4,$5,false,false,0) ON CONFLICT(level) DO UPDATE SET
      monthly_price=$2,yearly_price=$3,monthly_credits=$4,yearly_credits=$5`,[level,monthly,annual,credits,credits*12]);
  }
  await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_method_routes',
    '{"version":1,"card":{"enabled":false},"card_cn":{"enabled":false},"wechat_pay":{"enabled":false,"annualVerified":false},
      "alipay":{"enabled":false,"annualVerified":false}}')`);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
    SELECT 'stripe','fixture','test','price','price_overlap_'||level,id,'monthly',true,'standard','subscription'
    FROM membership_plans WHERE level='gold'`);
  const cases=await stripeMpUpgradeCases({admin,service,connect});
  cases.push(...(await stripeMpUpgradeCases({admin,service,connect,proCycle:'yearly'})).map(c=>'annual-'+c));
  cases.push(...await walletMembershipCases({admin,service,connect}));
  cases.push(...await stripeTestClockCases({admin,service,connect}));
  cases.push(...await stripeTestClockCases({admin,service,connect},'card_cn'));
  const data=()=>admin.query(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p),
    'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM subscription_credit_grants g),
    'sources',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM credit_source_entries e)) v`);
  const preserved=(await data()).rows[0].v;
  assert.ok(walletOriginals&&walletBefore&&walletChangedKeys,'wallet migration tested at its historical position');
  sql('BEGIN;\n'+walletOriginals.map(src=>src+';').join('\n')+'\nCOMMIT;');
  const walletRestored=objects();
  for(const key of walletChangedKeys.filter(key=>key.startsWith('fn:'))) {
    assert.equal(walletRestored[key],walletBefore[key],'wallet old body restored');
  }
  assert.equal(walletRestored['con:payment_orders'],
    finalCatalog['con:payment_orders'],'recovery retains the constraint for paid renewal rows');
  assert.deepEqual((await data()).rows[0].v,preserved,'wallet recovery preserves paid balances and retained credit sources');
  sql(read(walletMigration));
  // Forward-fix every later extension too; 0335 intentionally extends the same wallet functions.
  for(const file of laterMigrations(330))sql(read('packages/db/migrations/'+file));
  assert.deepEqual(objects(),finalCatalog,'wallet reapply restores complete final catalog');
  cases.push('wallet-migration-interruption-atomic','wallet-migration-repeat-acl-unchanged','wallet-recovery-preserves-paid-data');
  sql('BEGIN;\n'+originals.map(src=>src+';').join('\n')+'\nCOMMIT;');
  const restoredCatalog=objects();
  assert.deepEqual(Object.fromEntries(originalFunctionKeys.map(key=>[key,restoredCatalog[key]])),
    originalFunctionEntries,'original function definitions and ACL restore exactly');
  const withoutTargetFunctions=catalog=>Object.fromEntries(Object.entries(catalog)
    .filter(([key])=>!originalFunctionKeys.includes(key)));
  assert.deepEqual(withoutTargetFunctions(restoredCatalog),withoutTargetFunctions(finalCatalog),
    'rollback preserves later migrations and every non-target catalog object');
  assert.deepEqual((await data()).rows[0].v,preserved,'code rollback preserves balances, grants and source attribution');
  sql(read('packages/db/migrations/0322_pay_stripe_mp_upgrade_overlap.sql'));
  // Only these later migrations extend the three runtime functions restored above; payment bodies stay current.
  sql(read('packages/db/migrations/0324_paywall_profile_archive.sql'));
  sql(read('packages/db/migrations/0326_paywall_fusion_archive_fence.sql'));
  assert.deepEqual(objects(),finalCatalog,'reapplying after rollback restores the complete final catalog');
  cases.push('migration-interruption-rolls-back','migration-repeat-unchanged','rollback-preserves-financial-data','reapply-converges');
  console.log(JSON.stringify({result:'PASS',build,cases}));
} finally {
  await Promise.all(clients.map(db=>db.query('ROLLBACK').catch(()=>{})));
  await Promise.all(clients.map(db=>db.end()));
  docker(['rm','-f',name]);
}

// The required CI billing job calls this runner. Keep new failover fixtures isolated and sequential;
// the separate baseline job already checks every migration's repeat application and final fingerprint.
const failover=spawnSync(process.execPath,[resolve(root,'packages/db/tests/pay-failover/run-local.mjs'),'--quick'],
  {cwd:root,stdio:'inherit',timeout:600000});
if(failover.status!==0||failover.error)throw new Error(failover.error?.message??'PAY_FAILOVER_DATABASE_TEST_FAILED');
