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
export async function verifyProxyCountry(transport:typeof fetch=fetch){
 requireProxy();
 let country:string;
 try{
  const response=await transport('https://ipapi.co/country/',{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error();
  country=(await response.text()).trim();
 }catch{throw new Error('PROXY_COUNTRY_CHECK_FAILED');}
 if(!/^[A-Z]{2}$/.test(country))throw new Error('PROXY_COUNTRY_CHECK_FAILED');
 if(!allowedCountries.has(country))throw new Error('PROXY_COUNTRY_NOT_ALLOWED');
 return country;
}
