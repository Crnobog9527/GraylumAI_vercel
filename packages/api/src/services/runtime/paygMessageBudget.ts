/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

type Context = {
 modelId:string;historyItems:number;maxTurns:number;maxToolCalls:number;
 purposeBudget?:{historyItems:number};matching?:{candidates:Array<{modelId:string}>};
 attachedOrganizer?:{modelId:string;historyItems?:number};
};
/** SDK input items emit at most one wire message each. Reserve instructions and
 * current input plus four items per serial tool round (reasoning, assistant text,
 * function call and result). Reasoning normally emits no message; keep its slot.
 * Selectors may drop more history for byte limits, but cannot grow this budget.
 * Organizer selection is independent, after primary history has been committed. */
export function freezePaygMessageBudget(context:Context,policies:ReadonlyArray<{modelId:string;payg?:{maxMessages:number}}>):void {
 const limit=(modelId:string)=>{
  const count=policies.find(p=>p.modelId===modelId)?.payg?.maxMessages;
  if(!Number.isSafeInteger(count)||count!<2)throw new Error('BILL2_INPUT_PROFILE_INVALID');
  return count!;
 };
 const maximum=Math.min(limit(context.modelId),...(context.matching?.candidates.map(c=>limit(c.modelId))??[]));
 const reserved=2+4*Math.min(context.maxToolCalls,context.maxTurns-1);
 if(reserved>maximum)throw new Error('BILL2_INPUT_PROFILE_INVALID');
 context.historyItems=Math.min(context.historyItems,maximum-reserved);
 if(context.purposeBudget)context.purposeBudget.historyItems=context.historyItems;
 if(context.attachedOrganizer){
  const organizer=context.attachedOrganizer;
  organizer.historyItems=Math.min(organizer.historyItems??0,limit(organizer.modelId)-2);
 }
}
