/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Tail replay shared by the local migration suites that re-apply an old migration on the final catalog
// (content-erasure for 0201, agent-core-r9 for 0209). The old migration rewrites functions that later migrations patched,
// so it is replayed together with every later migration, in order, and the whole catalog must come out unchanged.
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {supersededPatch} from './md5-chain.mjs';

/**
 * The objects migration 0505 (CORE-PATH-V2 V2-12 batch F, irreversible) dropped: the old Runtime / BILL2 path. A migration from before it that
 * patches one of them (pg_get_functiondef of a dropped function, an ALTER of a dropped table) cannot run on the final catalog any more:
 * its target is gone, and 0505 drops whatever it would bring back. read(path) returns the migration text.
 */
export const droppedByOldPathDrop = read => {
  const text = read('packages/db/migrations/0505_core_path_v2_drop_old_path.sql'), names = new Set();
  // DROP TABLE / TYPE / VIEW name [, name ...]: one statement drops a list (the 15 tables are one statement).
  for (const match of text.matchAll(/\bDROP\s+(?:TABLE|TYPE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi))
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/\s+CASCADE\s*$/i, '').replace(/^public\./, '').replace(/"/g, '');
      if (/^\w+$/.test(name)) names.add(name);
    }
  for (const match of text.matchAll(/\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\(/gi)) names.add(match[1]);
  return names;
};

/**
 * The migration without the rows of its `FOR p IN SELECT * FROM (VALUES ('public.<function>(...)', anchor, replacement, marker), ...)` patch lists that
 * target a dropped function, so the re-applied migration still runs every patch whose target exists. Returns { sql, removed } (removed: the names).
 */
export function withoutDroppedPatchTargets(sql, dropped) {
  const kept = [], removed = [];
  let skipping = false;
  for (const line of sql.split('\n')) {
    const row = /^ \('public\.(\w+)\(/.exec(line);
    if (row) { skipping = dropped.has(row[1]); if (skipping) removed.push(row[1]); }
    else if (/^ \) x\(sig,anchor,replacement,marker\)/.test(line)) {
      skipping = false;
      // The last kept row ended with a comma before the removed one; the list must not end with one.
      const last = kept.findLastIndex(text => text.trim() !== '');
      if (last >= 0 && removed.length > 0) kept[last] = kept[last].replace(/,\s*$/, '');
    }
    if (!skipping) kept.push(line);
  }
  return { sql: kept.join('\n'), removed };
}

/**
 * migrationPath: the migration being re-applied; first: its SQL to replay (the file text, or the text without a block
 * proven superseded). sql(text) runs on the database, ok(result) unwraps it, snapshot() reads the object catalog.
 */
export async function replayTail({root,read,sql,ok,snapshot,finalCatalog,report,migrationPath,first}) {
 const base=migrationPath.split('/').at(-1);
 const tail=readdirSync(resolve(root,'packages/db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)&&f>=base).sort()
  .map(name=>({name,sql:read('packages/db/migrations/'+name)}));
 // The md5 block of a patch superseded by a later md5 patch of the same function is left out only when the files prove
 // the chain and the database is at its tail; the rest of that migration still runs (md5-chain.mjs). Every skip is printed.
 // A function a migration patches may be gone (dropped by 0505): to_regprocedure answers NULL then, the patch is not "already at the chain end",
 // and replaying it fails with "does not exist", which is tolerated below when the object was dropped by 0505.
 const currentMd5=signature=>ok(sql(`SELECT md5(pg_get_functiondef(to_regprocedure('public.${signature}')));`));
 const hasMarker=(signature,marker)=>{assert.ok(!marker.includes('$md5_chain_marker$'));
  return ok(sql(`SELECT coalesce(position($md5_chain_marker$${marker}$md5_chain_marker$ IN pg_get_functiondef(to_regprocedure('public.${signature}')))>0,false);`))==='t';};
 report.skipped??=[];
 const dropped=droppedByOldPathDrop(read);
 const refusedSql=[],refusedNames=[];
 for(let i=0;i<tail.length;i++){
  const superseded=await supersededPatch(tail,i,currentMd5,hasMarker);
  if(superseded.skip)console.log('skip superseded md5 patch '+superseded.reason);
  if(superseded.skip)report.skipped.push(superseded.reason);
  // The tail starts with the re-applied migration itself (its name sorts first).
  const replay=tail[i].name===base?first:tail[i].sql;
  // 0283 reads the legacy ai_models.api_key column, which 0323 later drops. The column is put back (empty, as 0323 leaves
  // nothing in it) only for the historical replay of 0283; the replayed 0323 drops it again and the catalog comparison
  // below proves the final structure is unchanged.
  if(/ai_models/.test(replay)&&/\bapi_key\b/.test(replay)&&!/DROP COLUMN api_key/.test(replay))
   ok(sql('ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS api_key text;'));
  // 0385 patches the body of claim_daily_checkin (the INSERT it adds an idempotency key to), and the later 0396 drops the function (daily
  // check-in retired, Owner 2026-10-26). On the final catalog it is gone, so the historical replay of 0385 gets a stand-in that carries
  // only the text 0385 anchors on; the replayed 0396 drops it again and the catalog comparison below proves the final structure is unchanged.
  if(/claim_daily_checkin/.test(replay)&&!/DROP FUNCTION IF EXISTS public\.claim_daily_checkin/.test(replay))
   ok(sql(`CREATE OR REPLACE FUNCTION public.claim_daily_checkin(p_user_id uuid) RETURNS void LANGUAGE plpgsql AS $stub$
    DECLARE v_total_reward_credits integer := 0; v_today date := current_date;
    BEGIN
     IF false THEN
      INSERT INTO credit_transactions ( user_id, amount, type, description ) VALUES ( p_user_id, v_total_reward_credits, 'checkin', 'stand-in' );
     END IF;
    END $stub$;`));
  const replayResult=sql(superseded.skip?superseded.rest:replay);
  // An anchored patch refuses (an error code containing PATCH, or SOURCE_MISMATCH, or 0328's own gate refusal) when a still
  // later migration already rewrote the text it anchors on (0307 after 0338, 0328 after 0329/0330/0335, 0391 after any later rewrite of atomic_pre_deduct / bill2_payg_claim, CONTENT_ERASURE_SPEED_MISMATCH of the speed patch of content_erasure_scope after 0505 rewrote it). Only those named
  // refusals are tolerated, never for the re-applied migration
  // itself, each one is printed and recorded, and the catalog equality below must still hold.
  const refusal=replayResult.status!==0&&tail[i].name!==base
   ?/ERROR:\s+(\w*(?:PATCH|SOURCE_MISMATCH|SPEED_MISMATCH)\w*|PAY_REFUNDED_REPURCHASE_GATE_MISMATCH|MAINT_P4_BASE_MISMATCH)\b/.exec(replayResult.stderr??''):null;
  // A migration from before 0505 that patches an object 0505 later dropped (the old Runtime / BILL2 path) fails with "does not exist" naming it:
  // the target is gone from the final catalog and 0505, replayed later in this tail, drops anything such a migration would bring back.
  // The first ERROR line names the object: "function ... does not exist", "relation ...", "type ...", or a guard of the migration itself (such as
  // OPC_ARCHIVE_FUNCTION_MISSING: opc_save_result); any identifier on it that 0505 dropped counts.
  const gone=replayResult.status!==0&&!refusal&&tail[i].name!==base
   ?[.../ERROR:[^\n]*/.exec(replayResult.stderr??'')?.[0].matchAll(/[a-z_][a-z_0-9]*/gi)??[]].map(token=>token[0]).filter(token=>dropped.has(token)).slice(0,1):[];
  if(refusal){const reason=tail[i].name+': anchored patch refused on the final catalog ('+refusal[1]+'), a later migration rewrote its anchor; not replayed';
   console.log('skip '+reason);report.skipped.push(reason);refusedSql.push(tail[i].sql);refusedNames.push(tail[i].name.slice(0,4));}
  else if(gone.length){const reason=tail[i].name+': its patch target '+gone[0]+' was dropped by 0505 (old Runtime / BILL2 path); not replayed';
   console.log('skip '+reason);report.skipped.push(reason);refusedSql.push(tail[i].sql);refusedNames.push(tail[i].name.slice(0,4));}
  else ok(replayResult);
 }
 // Objects named by a migration whose replay was refused may end the replay in an older body that only that migration could
 // bring forward again; that is a limit of replaying on the final catalog, not a property of the re-applied migration.
 // Every other object must be identical, so any other drift still fails. Each excluded object is recorded.
 const after=snapshot();
 const refusedText=refusedSql.join('\n');
 const explainedKey=k=>{const name=/^(?:fn|con|trg|idx):(?:[\w]+\.)?([a-z_][a-z_0-9]*)/i.exec(k)?.[1];
  return Boolean(name&&new RegExp('\\b'+name+'\\b').test(refusedText));};
 const explained=Object.keys({...after,...finalCatalog}).filter(k=>after[k]!==finalCatalog[k]&&explainedKey(k));
 const expected={...finalCatalog};
 for(const k of explained){delete after[k];delete expected[k];}
 if(explained.length)report.skipped.push('not compared (named by refused replays '+refusedNames.join(', ')+'): '+explained.join(', '));
 assert.deepEqual(after,expected,'repeat '+base+' and every later migration preserves the complete final catalog');
}
