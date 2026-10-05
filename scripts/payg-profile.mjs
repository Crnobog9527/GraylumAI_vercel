/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline only. There is intentionally no dispatch, credential, database or fetch code.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../packages/api/package.json',import.meta.url));
const viteRequire=createRequire(require.resolve('vite'));
const {build}=await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
const [mode,input,output,receipts]=process.argv.slice(2);
if(!['plan','record'].includes(mode)||!input||!output||(mode==='record'&&!receipts))
 throw new Error('Usage: node scripts/payg-profile.mjs plan prices.json manifest.json r4|r5 | record manifest.json report.json receipts.json');
const temporary=await mkdtemp(join(tmpdir(),'graylum-payg-offline-'));
try{
 const modulePath=join(temporary,'sampling.cjs');
 await build({entryPoints:[resolve('scripts/payg-profile/sampling.ts')],outfile:modulePath,bundle:true,platform:'node',format:'cjs'});
 process.env.NODE_ENV='test';
 const sampling=require(modulePath);
 const value=JSON.parse(await readFile(input,'utf8'));
 const result=mode==='plan'?sampling.createSamplePlan(value,receipts??'r4').manifest:
  sampling.recordSamples(value,JSON.parse(await readFile(receipts,'utf8')));
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(mode==='plan'?{calls:result.calls,totals:result.totals,totalUsd:result.totalUsd,
  blockers:result.blockers,manifestHash:result.manifestHash}:{samples:result.length},null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
