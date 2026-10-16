/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Compile the actual metric/classification producers so SQL acceptance cannot drift from a hand-written fixture.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
/** The real accountMetrics/classifyAccount, compiled from packages/api (no fixture copy). */
export async function benchmarkCode() {
  const root=resolve(import.meta.dirname,'../../../..'),src=resolve(root,'packages/api/src');
  const require=createRequire(resolve(root,'packages/api/package.json')),ts=require('typescript');
  const compiled=mkdtempSync(resolve(root,'packages/api/.research-cache-test-')),done=new Set();
  const emit=file=>{
    if(done.has(file))return;done.add(file);
    const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
      .replace(/from '(\.{1,2}\/[^']+)'/g,(_,spec)=>{
        const base=resolve(dirname(file),spec),found=[base+'.ts',base+'/index.ts'].find(existsSync);
        assert.ok(found,'unresolved import '+spec);emit(found);
        return `from '${spec}${found.endsWith('/index.ts')?'/index':''}.mjs'`;
      });
    const target=resolve(compiled,relative(src,file)).replace(/\.ts$/,'.mjs');
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,code);
  };
  try {
    const dir='services/research/benchmark/';
    for(const file of ['metrics','classify'])emit(resolve(src,dir+file+'.ts'));
    const {accountMetrics,suppliedWholeHistory}=await import(pathToFileURL(resolve(compiled,dir+'metrics.mjs')).href);
    const {classifyAccount,qualifyFetchedAccount}=await import(pathToFileURL(resolve(compiled,dir+'classify.mjs')).href);
    return {accountMetrics,classifyAccount,qualifyFetchedAccount,suppliedWholeHistory};
  } finally {rmSync(compiled,{recursive:true,force:true});}
}
export async function hostCaches() {
  const {accountMetrics,classifyAccount}=await benchmarkCode();
  const now=new Date('2026-10-16T00:00:00Z'),growth={maxFirstPostAgeDays:30,minViewsToFollowers:'1.5'};
  return [null,100,12000,250000].flatMap(followers=>[[],[{ref:'op#2',fields:{views:100,likes:1,comments:2,shares:3,
    publishedAt:'2026-10-10T00:00:00Z'},missing:[]}]].map(posts=>{
    const metrics=accountMetrics({profile:{ref:'op#1',fields:followers===null?{}:{followers},missing:[]},posts,complete:true},now);
    return {platform:'tiktok',account:'alpha',fetchedAt:now.toISOString(),metrics,
      classification:classifyAccount(metrics,growth,now)};
  }));
}
