/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** One server-created HTTP invocation budget, shared by every batched Runtime.
 * It is neither a frozen execution field nor an authority to retry/settle. */
export function createRuntimeBudget(now:()=>number=()=>performance.now()) {
 const startedAt=now();
 const workDeadline=startedAt+255_000,persistenceDeadline=startedAt+285_000;
 return Object.freeze({
  workDeadline,persistenceDeadline,
  remainingPersistence:()=>persistenceDeadline-now(),
  assertCanPersist(durationMs=0){
   if(now()+durationMs>=persistenceDeadline)throw new Error('RUNTIME_TIME_BUDGET_EXHAUSTED');
  },
  assertCanStart(durationMs=0){
   if(now()+durationMs>=workDeadline)throw new Error('RUNTIME_TIME_BUDGET_EXHAUSTED');
  },
 });
}
export type RuntimeBudget=ReturnType<typeof createRuntimeBudget>;
/** Native fetch cancellation also bounds response-body reads, including SQL.
 * An aborted database mutation is ambiguous; its original identity is retained. */
export function withRuntimeBudget(budget:RuntimeBudget,transport:typeof fetch=fetch,disableDatabaseRetry=false):typeof fetch {
 return async(input,init)=>{
  const remaining=Math.ceil(budget.remainingPersistence());
  if(remaining<=0)throw new DOMException('RUNTIME_TIME_BUDGET_EXHAUSTED','AbortError');
  const caller=init?.signal??(input instanceof Request?input.signal:undefined);
  const deadline=AbortSignal.timeout(remaining);
  try{
   const response=await transport(input,{...init,signal:caller?AbortSignal.any([caller,deadline]):deadline});
   // PostgREST sleeps after reading the error body, so even a short delay
   // checked at headers can exceed the deadline. Disable its implicit read
   // retries; AbortError is its existing non-retryable transport path. This
   // flag is only for Supabase, never provider responses or their evidence.
   const method=init?.method??(input instanceof Request?input.method:'GET');
   if(disableDatabaseRetry&&['GET','HEAD','OPTIONS'].includes(method.toUpperCase())&&[503,520].includes(response.status)){
    void response.body?.cancel().catch(()=>{});
    throw new DOMException('RUNTIME_DATABASE_RETRY_DISABLED','AbortError');
   }
   return response;
  }catch(error){
   if(deadline.aborted)throw new DOMException('RUNTIME_TIME_BUDGET_EXHAUSTED','AbortError');
   throw error;
  }
 };
}
