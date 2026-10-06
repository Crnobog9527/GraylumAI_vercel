/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline only. Reads the exact authorized r8 local observation; never loads credentials or sends.
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const req=createRequire(new URL('../packages/api/package.json',import.meta.url));
const vr=createRequire(req.resolve('vite'));
const {build}=await import(pathToFileURL(vr.resolve('esbuild')).href);
const sha=value=>createHash('sha256').update(value).digest('hex');
const temp=await mkdtemp(join(tmpdir(),'graylum-r9-private-regression-'));
try{
 const entry=join(temp,'regression.cjs');
 await build({stdin:{contents:`export {observationEvent,identityFor} from './scripts/payg-profile/executor';
 export {openRouterAdapter} from './packages/api/src/services/bill2/openRouterAdapter';
 export {recordSamples} from './scripts/payg-profile/sampling';`,resolveDir:process.cwd()},
 outfile:entry,bundle:true,platform:'node',format:'cjs'});
 const {observationEvent,identityFor,openRouterAdapter,recordSamples}=req(entry);
 const manifest=JSON.parse(await readFile(resolve('docs/launch/evidence/payg-profile-20261006-r8.manifest.json'),'utf8'));
 const prices=JSON.parse(await readFile(resolve('scripts/payg-profile/plan-prices.json'),'utf8'));
 const sample=manifest.samples[2];
 const directory=join(homedir(),'.local/state/graylum/payg-profile',manifest.manifestHash);
 const file=join(directory,sha(sample.id)+'-response.private.json');
 const bytes=await readFile(file),observation=JSON.parse(bytes.toString('utf8'));
 const adapter=openRouterAdapter({credential:async()=>{throw Error('NO_CREDENTIAL_ACCESS');},
  transport:async()=>{throw Error('NO_NETWORK');},allowWorkspaceRead:true,allowAgentTools:true});
 const event=observationEvent(adapter,observation,identityFor(sample,prices),'response',sample);
 if(event.sourceHash!=='be92ffafb046376df0233e51e38a0a916bb5d0ad7282ef67a98fee8c57ecb9ca'
   ||event.providerName!=='Anthropic'||event.costUsd!=='0.0076005'||!event.providerId||!event.finishReason
   ||event.rejected||!event.final||event.nativePromptTokens!==2046||event.nativeCompletionTokens!==314)
  throw Error('PRIVATE_REGRESSION_FAILED');
 const contents={samples:[sample],outputPressureCriterion:manifest.outputPressureCriterion};
 const [result]=recordSamples({...contents,manifestHash:sha(JSON.stringify(contents))},[{
  sampleId:sample.id,requestHash:sample.requestHash,model:sample.model,endpointTag:sample.endpointTag,
  nativePromptTokens:event.nativePromptTokens,nativeCompletionTokens:event.nativeCompletionTokens,costUsd:event.costUsd,
  cachedTokens:event.cachedTokens,cacheWriteTokens:event.cacheWriteTokens,source:'response.prompt_tokens',
  includesReasoning:true,finishReason:event.finishReason}]);
 if(result.status!=='SAMPLE_WITHIN_BOUNDS'||sha(await readFile(file))!==sha(bytes))throw Error('PRIVATE_REGRESSION_FAILED');
 console.log(JSON.stringify({regression:'PASS',sourceHash:event.sourceHash,generationIdHash:sha(event.providerId),
  providerName:event.providerName,finishReason:event.finishReason,P:event.nativePromptTokens,
  completion:event.nativeCompletionTokens,costUsd:event.costUsd,offlineVerdict:result.status,
  originalVerdict:'UNKNOWN',retainedAsQualifiedEvidence:false,networkCalls:0}));
}catch{
 console.error('PRIVATE_REGRESSION_FAILED');process.exitCode=1;
}finally{await rm(temp,{recursive:true,force:true});}
