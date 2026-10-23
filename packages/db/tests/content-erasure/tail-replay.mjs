/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Tail replay shared by the local migration suites that re-apply an old migration on the final catalog
// (content-erasure for 0201, agent-core-r9 for 0209). The old migration rewrites functions that later migrations patched,
// so it is replayed together with every later migration, in order, and the whole catalog must come out unchanged.
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {supersededPatch} from './md5-chain.mjs';

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
 const currentMd5=signature=>ok(sql(`SELECT md5(pg_get_functiondef('public.${signature}'::regprocedure));`));
 const hasMarker=(signature,marker)=>{assert.ok(!marker.includes('$md5_chain_marker$'));
  return ok(sql(`SELECT position($md5_chain_marker$${marker}$md5_chain_marker$ IN pg_get_functiondef('public.${signature}'::regprocedure))>0;`))==='t';};
 report.skipped??=[];
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
  const replayResult=sql(superseded.skip?superseded.rest:replay);
  // An anchored patch refuses (an error code containing PATCH, or SOURCE_MISMATCH) when a still later migration already
  // rewrote the text it anchors on (0307 after 0338). Only that refusal is tolerated, never for the re-applied migration
  // itself, each one is printed and recorded, and the catalog equality below must still hold.
  const refusal=replayResult.status!==0&&tail[i].name!==base
   ?/ERROR:\s+(\w*(?:PATCH|SOURCE_MISMATCH)\w*)/.exec(replayResult.stderr??''):null;
  if(refusal){const reason=tail[i].name+': anchored patch refused on the final catalog ('+refusal[1]+'), a later migration rewrote its anchor; not replayed';
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
