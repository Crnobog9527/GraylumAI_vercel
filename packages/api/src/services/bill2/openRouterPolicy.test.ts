/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {openRouterBound} from './openRouterPolicy';
const limits={providerSlug:'synthetic',contextTokens:128000,promptUsdPerMillion:'0.15',completionUsdPerMillion:'0.6',requestUsd:'0'};
it('freezes full provider capacity and matching exact wire price caps',()=>{
 expect(openRouterBound(limits,1000)).toEqual({upperUsd:'0.019800000000',routing:{allow_fallbacks:false,require_parameters:true,only:['synthetic'],max_price:{prompt:0.15,completion:0.6,request:0}}});
});
it('includes a per-request charge and conservatively rounds only the budget upper bound',()=>{
 expect(openRouterBound({...limits,contextTokens:3,promptUsdPerMillion:'0.000001',completionUsdPerMillion:'0.000001',requestUsd:'0.1'},1).upperUsd).toBe('0.100000000004');
});
it.each([0,-1,128000,NaN])('rejects invalid output limit %s',n=>expect(()=>openRouterBound(limits,n)).toThrow());
it.each(['-1','NaN','0.1234567890123'])('rejects invalid quoted price %s',value=>expect(()=>openRouterBound({...limits,promptUsdPerMillion:value},1000)).toThrow());

it('accepts the verified 1050000-token context with an exact full-context standard-price bound',()=>{
 const standard={providerSlug:'openai',contextTokens:1050000,promptUsdPerMillion:'0.4',completionUsdPerMillion:'1.8',requestUsd:'0'};
 expect(openRouterBound(standard,1000)).toEqual({upperUsd:'0.421800000000',routing:{allow_fallbacks:false,require_parameters:true,only:['openai'],max_price:{prompt:0.4,completion:1.8,request:0}}});
 // Existing contexts and their frozen routing/price bytes keep their old result.
 expect(openRouterBound({...standard,contextTokens:1000000},1000)).toEqual({upperUsd:'0.401800000000',routing:{allow_fallbacks:false,require_parameters:true,only:['openai'],max_price:{prompt:0.4,completion:1.8,request:0}}});
});
it.each([1050001,1050000.5,Infinity])('still rejects unverified or invalid context %s',contextTokens=>{
 expect(()=>openRouterBound({...limits,contextTokens},1000)).toThrow();
});
