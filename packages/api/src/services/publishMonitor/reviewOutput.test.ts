/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {exportReview} from './reviewOutput';
const id='10000000-0000-4000-8000-000000000001';
it('exports the owner-scoped host table separately from model prose; absent and erased results cannot export',async()=>{
 const result={id,periodStart:'2026-10-18',status:'completed',body:'Model says 999',tables:{views:12},notice:'本周复盘已生成'};
 const rpc=vi.fn(async()=>({data:[result],error:null}));
 const db={rpc} as never;
 const output=await exportReview(db,'owner',id);
 expect(rpc).toHaveBeenCalledWith('publish_monitor_reviews',{a:'owner'});
 expect(JSON.parse(output.content)).toMatchObject({type:'review',body:'Model says 999',tables:{views:12}});
 rpc.mockResolvedValueOnce({data:[],error:null});
 await expect(exportReview(db,'another-owner',id)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_NOT_FOUND');
 rpc.mockResolvedValueOnce({data:[{...result,body:null}],error:null} as never);
 await expect(exportReview(db,'owner',id)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_NOT_FOUND');
});
