/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {requireProxy,verifyProxyCountry} from '../../../../../scripts/payg-profile/proxy-preflight';
beforeEach(()=>{
 for(const name of ['NO_PROXY','no_proxy','https_proxy','NODE_OPTIONS'])vi.stubEnv(name,'');
 vi.stubEnv('NODE_USE_ENV_PROXY','1');vi.stubEnv('HTTPS_PROXY','http://127.0.0.1:9999');
});
afterEach(()=>vi.unstubAllEnvs());
it.each([
 [{NODE_USE_ENV_PROXY:'',HTTPS_PROXY:'http://localhost:9999'},'PROXY_REQUIRED'],
 [{NODE_USE_ENV_PROXY:'1'},'PROXY_REQUIRED'],
 [{NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:'invalid'},'PROXY_INVALID'],
 [{NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:'socks5://localhost:9999'},'PROXY_INVALID'],
 [{NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:'http://localhost:9999',NO_PROXY:'openrouter.ai'},'PROXY_BYPASS_NOT_ALLOWED'],
 [{NODE_USE_ENV_PROXY:'1',HTTPS_PROXY:'http://localhost:9999',https_proxy:'http://other:9999'},'PROXY_BYPASS_NOT_ALLOWED'],
])('requires explicit non-bypassed native proxy: %j',(env,code)=>{expect(()=>requireProxy(env)).toThrow(code);});
it('checks country exactly once without credentials, IP, redirect or model call',async()=>{
 const transport=vi.fn(async()=>new Response('US\n'));
 expect(await verifyProxyCountry(transport)).toBe('US');expect(transport).toHaveBeenCalledTimes(1);
 expect(transport).toHaveBeenCalledWith('https://ipapi.co/country/',{redirect:'error',signal:expect.any(AbortSignal)});
});
it.each(['CN','HK','XX','{"ip":"private"}',''])('denies unsupported or invalid country: %s',async(country)=>{
 const transport=vi.fn(async()=>new Response(country));
 await expect(verifyProxyCountry(transport)).rejects.toThrow(/^PROXY_COUNTRY_(NOT_ALLOWED|CHECK_FAILED)$/);
 expect(transport).toHaveBeenCalledTimes(1);
});
it('fails closed without retry or leaking network errors',async()=>{
 const transport=vi.fn(async()=>{throw new Error('sensitive proxy detail');});
 await expect(verifyProxyCountry(transport)).rejects.toThrow('PROXY_COUNTRY_CHECK_FAILED');
 expect(transport).toHaveBeenCalledTimes(1);
});
