/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks=vi.hoisted(()=>({auth:vi.fn(),create:vi.fn(),cleanup:vi.fn()}));
vi.mock('@/lib/cron-auth',()=>({validateCronRequest:mocks.auth}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.create}));
vi.mock('@repo/api/src/services/library/cleanup',()=>({runLibraryCleanup:mocks.cleanup}));
import { GET } from './route';
afterEach(()=>vi.unstubAllEnvs());
beforeEach(()=>{
 vi.resetAllMocks();
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://synthetic.supabase.co');
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-value');
 mocks.create.mockReturnValue({synthetic:true});
 mocks.cleanup.mockResolvedValue({checked:2,released:1,pending:1,failed:0,unknownPaths:0,scanCursor:'internal-cursor'});
});
it('denies unauthorized cron before any client or cleanup work',async()=>{
 mocks.auth.mockReturnValue(new Response('Unauthorized',{status:401}));
 expect((await GET(new Request('https://synthetic.test/api/cron/library-cleanup'))).status).toBe(401);
 expect(mocks.create).not.toHaveBeenCalled();expect(mocks.cleanup).not.toHaveBeenCalled();
});
it('uses the existing cron auth and does not return storage continuation',async()=>{
 const request=new Request('https://synthetic.test/api/cron/library-cleanup');
 const response=await GET(request);
 expect(mocks.auth).toHaveBeenCalledWith(request,'library_cleanup');
 expect(await response.json()).toEqual({success:true,checked:2,released:1,pending:1});
});
it('keeps provider errors private',async()=>{
 mocks.cleanup.mockRejectedValue(new Error('private token diagnostic'));
 const response=await GET(new Request('https://synthetic.test/api/cron/library-cleanup'));
 expect(response.status).toBe(500);expect(await response.json()).toEqual({error:'Library cleanup failed'});
});
it('does not start when configuration is absent',async()=>{
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');
 expect((await GET(new Request('https://synthetic.test/api/cron/library-cleanup'))).status).toBe(500);
 expect(mocks.cleanup).not.toHaveBeenCalled();
});
it('retains daily staging schedule without changing account-erasure timing',()=>{
 const config=JSON.parse(readFileSync('vercel.json','utf8'));
 expect(config.crons).toContainEqual({path:'/api/cron/library-cleanup',schedule:'0 6 * * *'});
 expect(config.crons).toContainEqual({path:'/api/cron/account-erasure',schedule:'0 5 * * *'});
});
