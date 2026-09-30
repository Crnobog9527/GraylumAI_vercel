/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {PURPOSE_OUTPUT_CAP} from '../../runtime/purposeBudgets';
// Capacity units, not a claim that a particular tokenizer emits one token here.
// U+0001 serializes as six ASCII bytes; é contributes two UTF-8 bytes.
export const outputUnit='\u0001é';
export const fullBudgetText=outputUnit.repeat(PURPOSE_OUTPUT_CAP);
export function mentorOutputFixture(withReasoning=true){
 const content=withReasoning?outputUnit:fullBudgetText;
 const reasoning=withReasoning?outputUnit.repeat(PURPOSE_OUTPUT_CAP-1):'';
 const message={role:'assistant',content,...(withReasoning?{reasoning,
  reasoning_details:[{index:0,type:'reasoning.text',text:reasoning}]}:{})};
 const response={id:'gen-'+ 'x'.repeat(252),object:'chat.completion',model:'test/model',
  choices:[{index:0,message,finish_reason:'stop'}],
  usage:{prompt_tokens:1,completion_tokens:PURPOSE_OUTPUT_CAP,total_tokens:PURPOSE_OUTPUT_CAP+1,
   cost:0.007,provider_metadata:''}};
 const generatedBytes=(withReasoning?2*PURPOSE_OUTPUT_CAP-1:PURPOSE_OUTPUT_CAP)*8;
 // Fill the COMPLETE JSON envelope to the allocated 8 KiB allowance.
 response.usage.provider_metadata='x'.repeat(8192-(Buffer.byteLength(JSON.stringify(response))-generatedBytes));
 const chunk=(delta:unknown,finish:string|null,usage?:unknown)=>'data: '+JSON.stringify({
  id:response.id,model:response.model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n';
 const wire=chunk(message,'stop')+chunk({},'stop',response.usage)+'data: [DONE]\n\n';
 return {response,wire,generatedBytes};
}
