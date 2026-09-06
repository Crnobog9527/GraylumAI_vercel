import type { SupabaseClient } from '@supabase/supabase-js';
export type OperationState = 'prepared'|'dispatched'|'succeeded'|'failed'|'unknown'|'cancelled';
export interface OperationRecord { identityHash?: string; claimed?: boolean; token?: string; state: OperationState; result?: ResearchResult | null }
export interface ResearchResult {
  source: 'agentkey'; fixture: boolean; canonicalTool: string;
  objects: { id: string; sourceUrl?: string; fields: Record<string,unknown>; missingFields: string[]; observedAt: string|null }[];
  fetchedAt: string; pagination: { complete: boolean; nextCursor: string|null };
  error: string|null; cost: { unit: 'agentkey-credit'; quoted: number; actual: number|null; status: 'reported'|'unknown' };
}
export interface PlannedOperation { operationId:string; identityHash:string; maxQuoteUnits:number }
export interface ResearchStore {
  create(planId:string, budgetUnits:number,operations:PlannedOperation[]):Promise<void>;
  get(planId:string,operationId:string):Promise<OperationRecord|null>;
  reserve(planId:string,operationId:string,identityHash:string,quoteUnits:number):Promise<OperationRecord>;
  dispatch(planId:string,operationId:string,token:string):Promise<boolean>;
  finish(planId:string,operationId:string,token:string,state:OperationState,result:ResearchResult|null):Promise<void>;
  cancel(planId:string):Promise<void>;
}
/** Construct only with the authenticated host actor after business admission.
 * RPC rechecks live actor status and plan ownership; never takes client owner claims. */
export function databaseResearchStore(db:SupabaseClient, actorId:string):ResearchStore {
  const call=async(action:string,planId:string,operationId:string|null,payload:Record<string,unknown>={})=>{
    const {data,error}=await db.rpc('research_transition',{p_action:action,p_plan_id:planId,p_actor_id:actorId,p_operation_id:operationId,p_payload:payload});
    if(error)throw new Error('RESEARCH_STATE_UNAVAILABLE');
    return data;
  };
  return {
    async create(id,budgetUnits,operations){await call('create',id,null,{budgetUnits,maxOperations:operations.length,operations});},
    get:(p,o)=>call('get',p,o),
    reserve:(p,o,identityHash,quoteUnits)=>call('reserve',p,o,{identityHash,quoteUnits}),
    async dispatch(p,o,token){return (await call('dispatch',p,o,{token}))?.dispatch===true;},
    async finish(p,o,token,state,result){await call('finish',p,o,{token,state,result});},
    async cancel(p){await call('cancel',p,null);},
  };
}
