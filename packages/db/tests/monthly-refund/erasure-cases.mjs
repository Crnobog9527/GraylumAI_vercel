/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
export async function checkErasureProof(db, good) {
 const check=async (value,expected,label)=>{
  const {rows}=await db.query('select monthly_refund_erasure_safe($1) ok',[value]);
  assert.equal(rows[0].ok,expected,label);
 };
 await check(good,true,'complete original terminal evidence');
 for(const path of [[],['terms'],['terms','snapshot'],['started'],['recordedRefund']]){
  const source=path.reduce((node,key)=>node[key],good);
  for(const key of Object.keys(source)){
   for(const mode of ['missing','null','wrong_type']){
    if(mode==='null'&&path[0]==='started'&&source[key]===null)continue;
    const broken=structuredClone(good);const object=path.reduce((node,k)=>node[k],broken);
    if(mode==='missing')delete object[key];else object[key]=mode==='null'?null:{unexpected:true};
    await check(broken,false,`${path.join('.')}.${key}: ${mode}`);
   }
  }
 }
 const mutate=async (path,value,label)=>{
  const broken=structuredClone(good);path.slice(0,-1).reduce((node,key)=>node[key],broken)[path.at(-1)]=value;
  await check(broken,false,label);
 };
 for(const field of ['approvedAt','claimedAt','finishedAt'])await mutate([field],'x',field);
 for(const field of ['paidAt','submittedAt','periodEnd'])await mutate(['terms',field],'infinity',field);
 for(const field of ['id','approvedBy'])await mutate([field],'invalid-uuid',field);
 for(const field of ['orderId','userId','ticketId','subscriptionId'])await mutate(['terms',field],'invalid-uuid',field);
 for(const [field,value] of [['paidMinor',0],['netMinor',1],['feeMinor',0],['basisMinor',1],['credits',1],
  ['plan','founder'],['mode','live'],['feePermitted','unknown'],['evidenceRefs',[]],['evidenceRefs',['a','b','c',null]],
  ['evidenceRefs',['a','b','c','  ']]])await mutate(['terms',field],value,field);
 await mutate(['recordedRefund','id'],'  ','blank cash identity');
 await mutate(['terms','snapshot','price'],69,'numeric snapshot price');
 await mutate(['terms','snapshot','billing_cycle'],'yearly','wrong snapshot scope');
 await mutate(['terms','snapshot','currency'],'cny','wrong snapshot currency');
 await mutate(['claimedAt'],'2000-01-01T00:00:00Z','claim before approval');
 await mutate(['started','refund'],'2000-01-01T00:00:00Z','stage before claim');
 await mutate(['started','restore_renewal'],good.started.refund,'success cannot restore renewal');
 await mutate(['hold'],'released','success must terminate source');
 await mutate(['recordedRefund','status'],'failed','contradictory cash terminal');
 const incomplete={...good,terms:{},started:{},recordedRefund:{status:'succeeded'},approvedBy:null,
  approvedAt:null,claimedAt:'x',finishedAt:'x'};
 await check(incomplete,false,'reviewer incomplete evidence reproducer');
 const proof=async()=>(await db.query('select account_erasure_financial_proof($1) p',[good.terms.userId])).rows[0].p;
 const before=await proof();
 await db.query('BEGIN');
 try {
  await db.query('update payment_orders set refund_approval=$1 where id=$2',[incomplete,good.terms.orderId]);
  const blocked=await proof();
  assert.equal(blocked.manualReview,before.manualReview+1,'incomplete refund adds actual financial completion blocker');
 } finally {await db.query('ROLLBACK');}
 assert.deepEqual(await proof(),before,'original financial authority unchanged after synthetic corrupt-fact probe');
}
