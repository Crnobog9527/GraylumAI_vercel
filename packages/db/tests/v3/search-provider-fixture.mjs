/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export function searchProviderFixture(){
 const calls=[];
 return async(req,res)=>{
  if(req.url==='/__search_calls'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(calls));return true;}
  if(!['/__gemini_search_fixture','/__chat_model_fixture'].includes(req.url))return false;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  const native=req.url==='/__gemini_search_fixture';
  const message=native?body.contents.at(-1).parts[0].text:body.messages.at(-1).content;
  const key=message.match(/(?:SEARCH|OPENROUTER)_CASE_[a-zA-Z0-9_-]+/)?.[0];
  calls.push({key,native,tools:body.tools??[],body});
  if(message.includes('_TIMEOUT_')){res.writeHead(504,{'Content-Type':'application/json'}).end(JSON.stringify({error:{status:'DEADLINE_EXCEEDED',message:'Synthetic provider deadline exceeded'}}));return true;}
  if(message.includes('_TRANSPORT_LOSS_')){res.destroy();return true;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(!native&&message.includes('OPENROUTER_CASE_')){
   // Synthetic account default: legacy web is ON but request-overridable.
   // Omitting plugins or [] really executes it; explicit false turns it off.
   const legacy=body.plugins?.find(p=>p.id==='web')?.enabled!==false;
   const offered=body.tools?.some(t=>t.type==='openrouter:web_search')&&body.tool_choice!=='none';
   const count=legacy?1:offered?(message.includes('_ZERO_')?0:message.includes('_MULTI')?3:1):0;
   calls.at(-1).performedQueries=count;calls.at(-1).legacyEnabled=legacy;
   const annotations=count?[
    {type:'url_citation',url_citation:{url:'https://example.test/openrouter-source',title:'OpenRouter verified source',start_index:0,end_index:6,content:'Synthetic public excerpt'}},
    {type:'url_citation',url_citation:{url:'javascript:document.body.innerHTML="UNSAFE"',title:'UNSAFE',start_index:0,end_index:6}},
   ]:[];
   const counter={web_search_requests:count};
   const usage={prompt_tokens:800,completion_tokens:30,total_tokens:830,cost:0.021,cost_details:{upstream_inference_prompt_cost:0.00012,upstream_inference_completions_cost:0.000018},server_tool_use:counter};
   if(message.includes('OPENROUTER_CASE_MISSING_'))delete usage.server_tool_use;
   if(message.includes('OPENROUTER_CASE_CORRUPT_'))usage.server_tool_use={web_search_requests:'invalid'};
   if(message.includes('_COST_MISSING_'))delete usage.cost;
   if(message.includes('_COST_CORRUPT_'))usage.cost=-1;
   if(message.includes('_ALIAS_')){delete usage.server_tool_use;usage.server_tool_use_details=counter;}
   if(message.includes('_BOTH_ALIASES_'))usage.server_tool_use_details=counter;
   if(message.includes('_COUNTER_CONFLICT_'))usage.server_tool_use_details={web_search_requests:count+1};
   res.write('data: '+JSON.stringify({id:'gen-'+key,choices:[{index:0,delta:{content:'Local answer '+key,annotations},finish_reason:'stop'}]})+'\n\n');
   const final={id:message.includes('_IDENTITY_CONFLICT_')?'gen-foreign':'gen-'+key,choices:[{index:0,delta:{},finish_reason:'stop'}],usage};
   if(message.includes('_CHOICE_ERROR_'))final.choices[0].error={code:500,message:'Synthetic server tool failed'};
   if(message.includes('_FINISH_ERROR_'))final.choices[0].finish_reason='error';
   if(message.includes('_TOOL_PENDING_')){final.choices[0].finish_reason='tool_calls';final.choices[0].delta.tool_calls=[{type:'function',function:{name:'search',arguments:'{}'}}];}
   res.write('data: '+JSON.stringify(final)+'\n\n');if(message.includes('_DUPLICATE_'))res.write('data: '+JSON.stringify(final)+'\n\n');
   res.end('data: [DONE]\n\n');return true;
  }
  if(!native){res.write('data: '+JSON.stringify({choices:[{delta:{content:'Local answer '+key}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:800,completion_tokens:30,total_tokens:830}})+'\n\n');res.end('data: [DONE]\n\n');return true;}
  const queryCount=message.includes('_ZERO_')?0:message.includes('_MULTI_')?3:1;
  const metadata={webSearchQueries:Array.from({length:queryCount},(_,i)=>'public query '+i),...(queryCount?{groundingChunks:[{web:{uri:'https://example.test/search-source',title:'Local verified source'}}],searchEntryPoint:{renderedContent:'<a href="https://www.google.com/search?q=public" target="_blank">Public search suggestion</a><script>parent.document.body.innerHTML="UNSAFE"</script>'}}:{})};
  const event={responseId:key,candidates:[{index:0,content:{parts:[{text:'Local answer '+key}]},finishReason:'STOP',...(body.tools?.length&&!message.includes('_MISSING_')?{groundingMetadata:message.includes('_CORRUPT_')?{webSearchQueries:'invalid'}:metadata}:{})}],usageMetadata:{promptTokenCount:800,candidatesTokenCount:30,totalTokenCount:830}};
  res.write('data: '+JSON.stringify(event)+'\n\n');
  if(message.includes('_DUPLICATE_'))res.write('data: '+JSON.stringify({responseId:key,candidates:[{index:0,groundingMetadata:metadata}],usageMetadata:event.usageMetadata})+'\n\n');
  res.end();return true;
 };
}
