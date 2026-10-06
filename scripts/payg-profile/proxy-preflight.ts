/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Conservative reviewed subset, not a complete provider availability list. Sources are in the execution guide.
const allowedCountries=new Set(['US','CA','GB','DE','FR','NL','JP','SG','AU','KR','TW']);
export function requireProxy(env:Record<string,string|undefined>=process.env){
 if(env.NODE_USE_ENV_PROXY!=='1'||!env.HTTPS_PROXY?.trim())throw new Error('PROXY_REQUIRED');
 let proxy:URL;
 try{proxy=new URL(env.HTTPS_PROXY);}catch{throw new Error('PROXY_INVALID');}
 if(!['http:','https:'].includes(proxy.protocol))throw new Error('PROXY_INVALID');
 // Lowercase variables can override uppercase; any bypass could send model traffic directly.
 if(env.https_proxy&&env.https_proxy!==env.HTTPS_PROXY||env.NO_PROXY?.trim()||env.no_proxy?.trim())
  throw new Error('PROXY_BYPASS_NOT_ALLOWED');
 if((env.NODE_OPTIONS??'').includes('--no-use-env-proxy')||process.execArgv.includes('--no-use-env-proxy'))
  throw new Error('PROXY_REQUIRED');
}
// Stream-filter before decoding: retain only a loc= candidate, never other field values or the full trace.
async function traceCountry(response:Response){
 const reader=response.body?.getReader();
 if(!reader)throw new Error();
 const prefix=[108,111,99,61];
 let position=0,ignored=false,tail:number[]=[],country:string|undefined,bytes=0;
 const finish=()=>{
  if(!ignored&&position>=4){
   if(country!==undefined||!(tail.length===2||tail.length===3&&tail[2]===13)
    ||tail[0]<65||tail[0]>90||tail[1]<65||tail[1]>90)throw new Error();
   country=String.fromCharCode(tail[0],tail[1]);
  }
  position=0;ignored=false;tail=[];
 };
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;if(bytes>65536)throw new Error();
   for(const byte of value){
    if(byte===10){finish();continue;}
    if(!ignored){
     if(position<4){if(byte!==prefix[position])ignored=true;}
     else{if(tail.length===3)throw new Error();tail.push(byte);}
    }
    position++;
   }
  }
  if(position)finish();
  if(country===undefined)throw new Error();
  return country;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function verifyProxyCountry(transport:typeof fetch=fetch){
 requireProxy();
 let country:string;
 try{
  const response=await transport('https://openrouter.ai/cdn-cgi/trace',{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error();
  country=await traceCountry(response);
 }catch{throw new Error('PROXY_COUNTRY_CHECK_FAILED');}
 if(!allowedCountries.has(country))throw new Error('PROXY_COUNTRY_NOT_ALLOWED');
 return country;
}
