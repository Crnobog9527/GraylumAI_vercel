/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable exact-ref runtime. Candidate code supplies only tests and local transport instrumentation.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
export function legacyRuntime(ref, source, env) {
 if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('exact immutable legacy SHA required');
 const root=mkdtempSync(resolve(tmpdir(),'graylum-bill2-legacy-'));
 try {
  const unpack=spawnSync('tar',['-x','-C',root],{input:execFileSync('git',['archive',ref],{cwd:source,maxBuffer:100*1024*1024})});
  if(unpack.status!==0)throw new Error('legacy archive failed');
  const files=execFileSync('git',['ls-tree','-r','--name-only',ref],{cwd:source,encoding:'utf8'}).trim().split('\n');
  for(const path of files.filter(p=>/(^|\/)\.env/.test(p)))rmSync(resolve(root,path),{force:true});
  const installed=spawnSync('pnpm',['install','--frozen-lockfile','--offline'],{cwd:root,env,stdio:'inherit'});if(installed.status!==0)throw new Error('legacy exact-lock install failed');
  console.log('LEGACY_RUNTIME',JSON.stringify({ref,tree:execFileSync('git',['rev-parse',ref+'^{tree}'],{cwd:source,encoding:'utf8'}).trim(),root}));
  return root;
 }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}
export function instrumentLegacy(root, apiUrl) {
 const patches=[['apps/web/src/app/api/ai/stream/route.ts','await fetch(endpoint,',`await fetch('${apiUrl}/__chat_model_fixture',`],
 ['packages/api/src/services/artifacts/generation.ts',"await fetch('https://openrouter.ai/api/v1/chat/completions',",`await fetch('${apiUrl}/__workbench_model_fixture',`],
 ['packages/api/src/services/agentSlice/runner.ts','await transport(url,',`await transport('${apiUrl}/__slice_model_fixture',`]];
 for(const [path,from,to] of patches){const file=resolve(root,path);if(!existsSync(file))continue;const text=readFileSync(file,'utf8');if(text.split(from).length!==2)throw new Error('legacy fixture transport mismatch '+path);writeFileSync(file,text.replace(from,to));}
 const search=resolve(root,'packages/api/src/services/research/workbenchSearch.ts');
 if(existsSync(search)){const text=readFileSync(search,'utf8'),marker="options=>connectAgentKey(options,process.env.AGENTKEY_API_KEY??'')";
  if(text.split(marker).length!==2)throw new Error('legacy research fixture mismatch');
  writeFileSync(search,text.replace('connectAgentKey, researchIdentity,','connectAgentKey, connectLocalAgentKey, researchIdentity,').replace(marker,"async options=>{const row=await privateClient.from('system_settings').select('value').eq('key','local_research_endpoint').single();return connectLocalAgentKey(options,new URL(row.data.value));}"));
 }
}
export function copyLegacyTests(candidate,legacy) {
 // Test-only files; the actual services, routes, schema TS and dependency lock remain the old version.
 for(const path of ['packages/api/src/services/__tests__','packages/api/src/routers/ordinaryChatReliability.integration.ts','packages/api/vitest.integration.config.ts']) cpSync(resolve(candidate,path),resolve(legacy,path),{recursive:true});
}

// The supported rollback bundle retains exactly these two reader compatibility changes.
// Apply in stages to prove each untouched decoder failure through the actual old HTTP app.
export function patchLegacyFinanceReader(root, evidenceDirectory, stage='complete') {
 const path='packages/api/src/routers/admin.ts', file=resolve(root,path), before=readFileSync(file,'utf8');
 const ledgerFrom="  type: z.enum(['deduction', 'addition', 'purchase', 'refund']),";
 const ledgerTo="  type: z.enum(['deduction', 'addition', 'purchase', 'refund', 'consumption', 'adjustment']),";
 const cacheFrom='  cached_tokens: z.number().finite(),', cacheTo='  cached_tokens: z.number().finite().nullable(),';
 const from=stage==='ledger'?ledgerFrom:cacheFrom, to=stage==='ledger'?ledgerTo:cacheTo;
 if(before.split(from).length!==2 || (stage==='complete'&&!before.includes(ledgerTo)))throw new Error('legacy reader patch mismatch');
 const ledgerLine=before.slice(0,before.indexOf(stage==='ledger'?ledgerFrom:ledgerTo)).split('\n').length;
 const cacheLine=before.slice(0,before.indexOf(cacheFrom)).split('\n').length;
 const patch=`--- a/${path}\n+++ b/${path}\n@@ -${ledgerLine} +${ledgerLine} @@\n-${ledgerFrom}\n+${ledgerTo}\n`+(stage==='ledger'?'':`@@ -${cacheLine} +${cacheLine} @@\n-${cacheFrom}\n+${cacheTo}\n`);
 const sha256=createHash('sha256').update(patch).digest('hex');
 writeFileSync(resolve(evidenceDirectory,stage==='ledger'?'legacy-ledger-reader-compat.patch':'legacy-reader-compat.patch'),patch);
 writeFileSync(file,before.replace(from,to));console.log('LEGACY_READER_COMPAT',JSON.stringify({stage,path,sha256}));
}
