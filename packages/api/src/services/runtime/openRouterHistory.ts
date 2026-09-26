/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

const reasoningDetails=z.array(z.object({type:z.literal('reasoning.text'),text:z.string(),
 index:z.number().int().nonnegative(),format:z.literal('unknown'),
}).strict()).nullish();
const reasoning=z.string().nullish();
const textParts=z.array(z.object({type:z.literal('text'),text:z.string(),role:z.literal('assistant').optional(),
 refusal:z.null().optional(),reasoning,reasoning_details:reasoningDetails,tool_calls:z.array(z.unknown()).nullish(),
}).strict());

/** Only the v2 frozen format uses this projection before request hashing.
 * SDK 0.18 carries response metadata into assistant text parts on later turns.
 * Preserve text and top-level tool semantics; unknown metadata/content fails closed.
 * The original adapter still validates tools, message roles and routing. */
export function normalizeOpenRouterHistory(request:{messages?:unknown}):void {
 if(!Array.isArray(request.messages))return;
 request.messages=request.messages.map(message=>{
  if(!message||typeof message!=='object'||Array.isArray(message)||message.role!=='assistant')return message;
  const normalized={...message};
  if(!reasoning.safeParse(message.reasoning).success||!reasoningDetails.safeParse(message.reasoning_details).success)
   throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
  delete normalized.reasoning;delete normalized.reasoning_details;
  if(Array.isArray(message.content)){
   const parsed=textParts.safeParse(message.content);
   if(!parsed.success)throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
   for(const part of parsed.data){
    // A duplicated tool field is removable only when the actual top-level calls
    // are identical. Unknown or parallel calls remain for the adapter to reject.
    if(part.tool_calls?.length&&!isDeepStrictEqual(part.tool_calls,message.tool_calls))
     throw new Error('RUNTIME_PROVIDER_HISTORY_DENIED');
   }
   normalized.content=parsed.data.map(part=>part.text).join('');
  }
  return normalized;
 });
}
