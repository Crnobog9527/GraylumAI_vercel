/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Probe-only preflight: the same Node global fetch/proxy path as the paid request.
export function requireMentorProxy(env=process.env,args=process.execArgv) {
  if(!args.includes('--use-env-proxy'))throw new Error('MENTOR_NODE_PROXY_FLAG_REQUIRED');
  const proxy=env.HTTPS_PROXY;
  if(!proxy||env.HTTP_PROXY!==proxy||
    (env.https_proxy&&env.https_proxy!==proxy)||(env.http_proxy&&env.http_proxy!==proxy))
    throw new Error('MENTOR_PROXY_ENV_REQUIRED');
  let url;
  try{url=new URL(proxy);}catch{throw new Error('MENTOR_PROXY_URL_INVALID');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('MENTOR_PROXY_URL_INVALID');
  for(const value of [env.NO_PROXY,env.no_proxy]){
    if(value?.split(',').some(part=>!['localhost','127.0.0.1','::1'].includes(part.trim())))
      throw new Error('MENTOR_PROXY_BYPASS_DENIED');
  }
}

export async function checkOpenRouterUS(upstream=fetch) {
  try {
    const response=await upstream('https://openrouter.ai/cdn-cgi/trace',{
      redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'},
    });
    if(!response.ok||!response.body)throw new Error('trace');
    const reader=response.body.getReader();let text='',size=0;
    try{
      for(;;){const part=await reader.read();if(part.done)break;
        size+=part.value.length;if(size>4096)throw new Error('trace');
        text+=new TextDecoder().decode(part.value);
      }
    }finally{await reader.cancel().catch(()=>{});}
    const hosts=text.match(/^h=.+$/gm),countries=text.match(/^loc=.+$/gm);
    if(hosts?.length!==1||hosts[0]!=='h=openrouter.ai'||countries?.length!==1||countries[0]!=='loc=US')
      throw new Error('trace');
    return {phase:'network-preflight',country:'US',host:'openrouter.ai',checkedAt:new Date().toISOString()};
  }catch{throw new Error('MENTOR_OPENROUTER_US_NOT_CONFIRMED');}
}
