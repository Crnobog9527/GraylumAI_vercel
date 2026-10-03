/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {decimal} from './decimal';
// Hard per-call deadlines: whitespace/keepalives never extend the body read.
export const OPENROUTER_RESPONSE_TIMEOUT_MS=240_000;
export const OPENROUTER_LOOKUP_TIMEOUT_MS=45_000;
export const openRouterLimits=z.object({
 providerSlug:z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/),
 contextTokens:z.number().int().min(1).max(1_050_000),
 promptUsdPerMillion:z.string(),completionUsdPerMillion:z.string(),requestUsd:z.string(),
 // MODEL-PRICING-SYNC / #572: total price of one cache-written token. Optional; absent on older quotes.
 cacheWriteUsdPerMillion:z.string().optional(),
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
 * Quotes are frozen in single-field form (deriveFrozenPrices): prompt already
 * is the highest input price, so cacheWriteUsdPerMillion never raises a
 * derived bound; it still counts if a quote states a higher write price.
 */
export function openRouterBound(value:OpenRouterLimits,maxOutputTokens:number){
 const limits=openRouterLimits.parse(value);
 if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>=limits.contextTokens)throw new Error('BILL2_PROVIDER_CAPACITY');
 const listed=decimal(limits.promptUsdPerMillion),completion=decimal(limits.completionUsdPerMillion),request=decimal(limits.requestUsd);
 const write=limits.cacheWriteUsdPerMillion===undefined?0n:decimal(limits.cacheWriteUsdPerMillion);
 const prompt=write>listed?write:listed;
 const numerator=prompt*BigInt(limits.contextTokens)+completion*BigInt(maxOutputTokens);
 const bound=(numerator+999_999n)/1_000_000n+request;
 if(bound<=0n)throw new Error('BILL2_PROVIDER_QUOTE_INVALID');
 return {upperUsd:formatted(bound),routing:{allow_fallbacks:false as const,require_parameters:true as const,only:[limits.providerSlug],max_price:{
  prompt:wireNumber(limits.promptUsdPerMillion),completion:wireNumber(limits.completionUsdPerMillion),request:wireNumber(limits.requestUsd),
 }}};
}


/** B is the final serialized request, including any cache block exactly once. */
export function measureCallInput(serializedRequest:string,protocolOverhead:number,safetyMargin:number){
  for(const value of [protocolOverhead,safetyMargin]){
    if(!Number.isSafeInteger(value)||value<0)throw new Error('BILL2_INPUT_PROFILE_INVALID');
  }
  const requestBytes=new TextEncoder().encode(serializedRequest).length;
  const promptTokensUpper=requestBytes+protocolOverhead+safetyMargin;
  if(requestBytes<1||!Number.isSafeInteger(promptTokensUpper))throw new Error('BILL2_INPUT_PROFILE_INVALID');
  return {requestBytes,promptTokensUpper};
}

/** v2 only: same price maxima, routing and 12-place upward rounding as v1. */
export function openRouterCallBound(value:OpenRouterLimits,maxOutputTokens:number,promptTokensUpper:number){
  const limits=openRouterLimits.parse(value);
  if(!Number.isSafeInteger(promptTokensUpper)||promptTokensUpper<1
    ||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1
    ||promptTokensUpper+maxOutputTokens>limits.contextTokens)throw new Error('BILL2_PROVIDER_CAPACITY');
  const listed=decimal(limits.promptUsdPerMillion);
  const write=limits.cacheWriteUsdPerMillion===undefined?0n:decimal(limits.cacheWriteUsdPerMillion);
  const prompt=write>listed?write:listed;
  const numerator=prompt*BigInt(promptTokensUpper)+decimal(limits.completionUsdPerMillion)*BigInt(maxOutputTokens);
  const bound=(numerator+999_999n)/1_000_000n+decimal(limits.requestUsd);
  if(bound<=0n)throw new Error('BILL2_PROVIDER_QUOTE_INVALID');
  return {upperUsd:formatted(bound),routing:openRouterBound(limits,maxOutputTokens).routing};
}
