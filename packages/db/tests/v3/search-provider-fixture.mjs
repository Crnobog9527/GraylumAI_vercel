/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export function searchProviderFixture(){
 const calls=[];
 return async(req,res)=>{
  if(req.url==='/__search_calls'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(calls));return true;}
  if(!['/__gemini_search_fixture','/__chat_model_fixture'].includes(req.url))return false;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  const native=req.url==='/__gemini_search_fixture';
  const message=native?body.contents.at(-1).parts[0].text:body.messages.at(-1).content;
  const key=message.match(/SEARCH_CASE_[a-zA-Z0-9_-]+/)?.[0];
  calls.push({key,native,tools:body.tools??[],body});
  if(message.includes('_TIMEOUT_')){res.destroy();return true;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(!native){res.write('data: '+JSON.stringify({choices:[{delta:{content:'Local answer '+key}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:800,completion_tokens:30,total_tokens:830}})+'\n\n');res.end('data: [DONE]\n\n');return true;}
  const queryCount=message.includes('_ZERO_')?0:message.includes('_MULTI_')?3:1;
  const metadata={webSearchQueries:Array.from({length:queryCount},(_,i)=>'public query '+i),...(queryCount?{groundingChunks:[{web:{uri:'https://example.test/search-source',title:'Local verified source'}}],searchEntryPoint:{renderedContent:'<a href="https://www.google.com/search?q=public" target="_blank">Public search suggestion</a><script>parent.document.body.innerHTML="UNSAFE"</script>'}}:{})};
  const event={responseId:key,candidates:[{index:0,content:{parts:[{text:'Local answer '+key}]},finishReason:'STOP',...(body.tools?.length&&!message.includes('_MISSING_')?{groundingMetadata:message.includes('_CORRUPT_')?{webSearchQueries:'invalid'}:metadata}:{})}],usageMetadata:{promptTokenCount:800,candidatesTokenCount:30,totalTokenCount:830}};
  res.write('data: '+JSON.stringify(event)+'\n\n');
  if(message.includes('_DUPLICATE_'))res.write('data: '+JSON.stringify({responseId:key,candidates:[{index:0,groundingMetadata:metadata}],usageMetadata:event.usageMetadata})+'\n\n');
  res.end();return true;
 };
}
