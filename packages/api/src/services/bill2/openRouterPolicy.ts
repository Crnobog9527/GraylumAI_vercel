/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {decimal} from './decimal';
export const openRouterLimits=z.object({
 providerSlug:z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/),
 contextTokens:z.number().int().min(1).max(1_050_000),
 promptUsdPerMillion:z.string(),completionUsdPerMillion:z.string(),requestUsd:z.string(),
}).strict();
export type OpenRouterLimits=z.infer<typeof openRouterLimits>;
const scale=1_000_000_000_000n;
function formatted(n:bigint){return (n/scale).toString()+'.'+(n%scale).toString().padStart(12,'0');}
function wireNumber(value:string){
 const exact=decimal(value),number=Number(value);
 // Accept only a wire representation with exactly the frozen decimal digits.
 // This conversion never computes money; the actual bound uses bigint below.
 if(!Number.isFinite(number)||decimal(JSON.stringify(number))!==exact)throw new Error('BILL2_PRICE_WIRE_UNREPRESENTABLE');
 return number;
}
/** Reserve the entire provider context, not an estimate based on UTF-8 bytes.
 * Token acceptance remains the provider's responsibility; the local history
 * byte cap is only a transport bound. Actual settlement uses official usage.
 * max_price uses USD/million prompt/completion and USD/request.
 */
export function openRouterBound(value:OpenRouterLimits,maxOutputTokens:number){
 const limits=openRouterLimits.parse(value);
 if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>=limits.contextTokens)throw new Error('BILL2_PROVIDER_CAPACITY');
 const prompt=decimal(limits.promptUsdPerMillion),completion=decimal(limits.completionUsdPerMillion),request=decimal(limits.requestUsd);
 const numerator=prompt*BigInt(limits.contextTokens)+completion*BigInt(maxOutputTokens);
 const bound=(numerator+999_999n)/1_000_000n+request;
 if(bound<=0n)throw new Error('BILL2_PROVIDER_QUOTE_INVALID');
 return {upperUsd:formatted(bound),routing:{allow_fallbacks:false as const,require_parameters:true as const,only:[limits.providerSlug],max_price:{
  prompt:wireNumber(limits.promptUsdPerMillion),completion:wireNumber(limits.completionUsdPerMillion),request:wireNumber(limits.requestUsd),
 }}};
}
