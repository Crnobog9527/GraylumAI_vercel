/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { WaffoPancake } from '@waffo/pancake-ts';
const env = parseEnv(fs.readFileSync(homedir() + '/.graylum/secrets/waffo-test.env', 'utf8'));
if (env.WAFFO_ENV !== 'test') throw new Error('Test mode required');
const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /checkoutUrl|signature|token|secret|private|email|address|buyer|customer|card|phone/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  let out = value;
  for (const k of ['WAFFO_PRIVATE_KEY','WAFFO_MERCHANT_ID','WAFFO_STORE_ID']) out = out.split(env[k]).join(`[${k}]`);
  return out.replace(/#token=.*/g, '#[REDACTED]');
};
const client = new WaffoPancake({merchantId:env.WAFFO_MERCHANT_ID,privateKey:env.WAFFO_PRIVATE_KEY,environment:'test',
  fetch: async (url, init) => {
    if (url !== 'https://api.waffo.ai/v1/graphql') throw new Error('Read only probe');
    const response = await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(30000)});
    return response;
  }});
try {
 const result = await client.graphql.query({query:fs.readFileSync(process.argv[2],'utf8'),variables:{storeId:env.WAFFO_STORE_ID}});
 const safe=JSON.stringify(redact(result),null,2);
 if (process.argv[3]) fs.writeFileSync(process.argv[3],safe+'\n');
 console.log(safe);
} catch(e) {console.log(JSON.stringify({error:true,status:e.status??null,type:e.name,details:redact(e.errors??[])}));process.exitCode=1;}
