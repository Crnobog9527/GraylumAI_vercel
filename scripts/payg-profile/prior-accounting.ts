/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {createR5bPlan} from './batch-r5b';
import {decimal} from '../../packages/api/src/services/bill2/decimal';
type Prior=ReturnType<typeof createR5bPlan>['manifest']['batch']['previous'];
/** Called only after exact reviewed manifest verification. Historical reports stay read-only.
 * No local report means the published audited evidence is authoritative; a present lock
 * requires exact reconciliation, including the identity of every approved UNKNOWN. */
export async function checkPriorAccounting(root:string,prior:Prior){
 for(const batch of prior){
  const directory=join(root,batch.manifestHash);
  try{await readFile(join(directory,'attempted.lock'));}
  catch(error){if((error as {code?:string}).code==='ENOENT')continue;throw new Error('PRIOR_ACCOUNTING_MISMATCH');}
  try{
   const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
   const zero=batch.ownerConfirmedZero;
   if(report.manifestHash!==batch.manifestHash||report.knownUsd!==batch.confirmedReceiptUsd
    ||report.unknownCostSamples!==zero.length||!Array.isArray(report.report))throw new Error();
   const unknown=report.report.filter((s:{actualUsd?:unknown})=>s.actualUsd===null);
   if(unknown.length!==zero.length||unknown.some((s:{id:string;requestHash:string;status:string})=>
    !zero.some(z=>z.sampleId===s.id&&z.requestHash===s.requestHash&&s.status===z.receiptStatus)))throw new Error();
   if(new Set(unknown.map((s:{id:string})=>s.id)).size!==zero.length)throw new Error();
   if(report.actualUsd!==(zero.length?null:batch.confirmedReceiptUsd))throw new Error();
   const sum=report.report.reduce((n:bigint,s:{actualUsd:string|null})=>n+(s.actualUsd===null?0n:decimal(s.actualUsd)),0n);
   if(sum!==decimal(batch.confirmedReceiptUsd)||sum+zero.reduce((n,z)=>n+decimal(z.accountedUsd),0n)!==decimal(batch.accountedUsd))
    throw new Error();
  }catch{throw new Error('PRIOR_ACCOUNTING_MISMATCH');}
 }
}
