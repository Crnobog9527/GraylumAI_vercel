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
// 0385 also patches claim_daily_checkin, which 0396 retired; a replay on the finished database skips that one patch.
const replayable=file=>{
  const text=read('packages/db/migrations/'+file);
  // 0334 patches the organizer-pending gate of runtime_admit and opc_step_material; V2-12 R1b removed that gate from opc_step_material
  // (the organizer belongs to the old path), so a replay on the finished database patches runtime_admit only.
  if(file.startsWith('0334_')) {
    const gone=",\n  'public.opc_step_material(uuid,uuid,uuid,text,text,text)']";
    assert.ok(text.includes(gone),'0334 still lists opc_step_material in its patch');
    return text.replace(gone,']');
  }
  if(!file.startsWith('0385_'))return text;
  const checkinPatch=/SELECT pg_temp\.e3_patch\('public\.claim_daily_checkin\(uuid\)',[\s\S]*?\$r\$\);\n/;
  assert.ok(checkinPatch.test(text),'0385 still carries the check-in patch this replay removes');
  return text.replace(checkinPatch,'');
};
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
// 0391 checks the md5 of the claim it replaces; 0416 (DB-RW-A) later turned one row lock of that claim into a switch, so put
// the original single statement back before 0391 is replayed on a finished database (the replay of 0416 after it restores
// the switch).
const restoreClaimThresholdLock=()=>{
  const claim=sql("SELECT pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);");
  const switched=" IF runtime_rw_flag('sharedRowLocks') THEN SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds';\n"
    +" ELSE SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;END IF;\n";
  const original=" SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;\n";
  if(claim.includes(switched))sql(claim.replace(switched,original)+';');
};
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
  // (V2-12 F: the rollback and forward-fix drills of the 0322 and wallet migrations restored and replayed the old function texts of
  // atomic_pre_deduct, bill2_payg_compensate and opc_start_b1 and of every later migration over them; bill2_payg_compensate and the
  // old admission are gone with batch F, so the drills have nothing left to restore. The behaviour cases above run on the finished database.)
  console.log(JSON.stringify({result:'PASS',build,cases}));
} finally {
  await Promise.all(clients.map(db=>db.query('ROLLBACK').catch(()=>{})));
  await Promise.all(clients.map(db=>db.end()));
  docker(['rm','-f',name]);
}

// The required CI billing job calls this runner. Keep new failover fixtures isolated and sequential;
// the separate baseline job already checks every migration's repeat application and final fingerprint.
const failover=spawnSync(process.execPath,[resolve(root,'packages/db/tests/pay-failover/run-local.mjs'),process.argv[2],'--quick'],
  {cwd:root,stdio:'inherit',timeout:600000});
if(failover.status!==0||failover.error)throw new Error(failover.error?.message??'PAY_FAILOVER_DATABASE_TEST_FAILED');
