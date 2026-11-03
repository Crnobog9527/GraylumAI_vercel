/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({log:vi.fn()}));
vi.mock('@supabase/ssr',()=>({createServerClient:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:vi.fn()}));
vi.mock('@/lib/rateLimit',()=>({checkRateLimit:async()=>({success:false,reason:'unavailable'})}));
vi.mock('@/lib/server-log',()=>({logServerError:mocks.log}));
import {proxy} from './proxy';
it('logs a pre-handler conversation deletion 503 with its admission reason',async()=>{
 const req=new NextRequest('https://auth-staging.graylum.com/api/trpc/account.conversationErasure',{method:'POST'});
 expect((await proxy(req)).status).toBe(503);
 expect(mocks.log).toHaveBeenCalledWith('api','proxy_service_unavailable',{
  reasonCode:'RATE_LIMIT_BACKEND_UNAVAILABLE',operation:'conversation_erasure',
 });
});
