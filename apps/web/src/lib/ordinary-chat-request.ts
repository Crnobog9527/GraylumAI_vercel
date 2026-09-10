import { publicSearchEvidence } from '@repo/api/src/services/providerUsage';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BillingService } from '@repo/api/src/services/billing';

export type ChatInput = { message: string; conversationId: string | null; modelId: string | null; moduleId: string | null };
export type ChatRequest = {
  request_id: string; user_id: string; input: ChatInput; conversation_id: string;
  writer_token: string; state: 'preparing'|'running'|'unknown'|'responded'|'succeeded'|'failed';
  partial_content: string|null; pre_deduct_id: string|null; reservation: any; response_params: any; billing_result: any;
  failure_reason: string|null; stop_requested_at: string|null; updated_at: string;
};
export class ChatRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function ordinaryChatRequest(admin: any, userId: string, requestId: string, writerToken: string) {
  const transition = async (action: string, params: any = {}) => {
    const r = await admin.rpc('ordinary_chat_transition', {p_user_id:userId,p_request_id:requestId,p_writer_token:writerToken,p_action:action,p_params:params});
    if(r.error || !r.data) throw new ChatRequestError(503,'请求状态暂时无法确认，请恢复原请求。');
    return r.data;
  };
  // Keep BillingService's pricing metadata and invitation handling. Only these
  // ordinary-chat atomic calls acquire the request row lock in the same SQL tx.
  const client = new Proxy(admin, {get(target,key) {
    if(key==='rpc') return async (name:string, params:any) => {
      const actions:Record<string,string>={atomic_pre_deduct:'reserve',atomic_finalize_ai_success:'success',atomic_finalize_ai_failure:'failure'};
      if(!actions[name]) return target.rpc(name,params);
      if(name==='atomic_finalize_ai_success') {
        try { await transition('respond',params); }
        catch {
          // Read the durable outcome before replaying the same saved response.
          // This never authorizes another provider call or a failure refund.
          const saved=await readChatRequest(admin,userId,requestId);
          if(saved?.state==='succeeded')return {data:[saved.billing_result],error:null};
          if(!saved || !['running','unknown','responded'].includes(saved.state))throw new ChatRequestError(503,'原回复保存状态待确认。');
          await transition('respond',params);
        }
      }
      return {data:await transition(actions[name],params),error:null};
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {transition,billing:new BillingService({supabase:client,userId})};
}

export async function readChatRequest(admin:any,userId:string,requestId:string):Promise<ChatRequest|null> {
  const result=await admin.from('ordinary_chat_requests').select('*').eq('request_id',requestId).maybeSingle();
  if(result.error) throw new ChatRequestError(503,'请求状态暂时无法读取，请稍后恢复原请求。');
  if(result.data && result.data.user_id!==userId) throw new ChatRequestError(403,'请求不可用或无权访问。');
  return result.data;
}

export async function claimChatRequest(admin:any,userId:string,requestId:string,input:ChatInput,writerToken:string) {
  const result=await admin.rpc('ordinary_chat_claim',{p_user_id:userId,p_request_id:requestId,p_input:input,p_writer_token:writerToken});
  if(result.error || !result.data) {
    if(result.error?.message?.includes('CHAT_IDENTITY_CONFLICT')) throw new ChatRequestError(409,'同一请求标识不能用于不同的内容或配置。');
    throw new ChatRequestError(503,'请求暂时无法保存，请恢复原请求确认状态。');
  }
  return result.data as {claimed:boolean;request:ChatRequest};
}

export function publicChatRequest(r:ChatRequest) {
  const p=r.response_params, b=r.billing_result;
  const state=(r.state==='preparing'||r.state==='running') && Date.now()-Date.parse(r.updated_at)>120000 ? 'unknown' : r.state;
  return { requestId:r.request_id,conversationId:r.conversation_id,input:r.input,state,
    stopped:!!r.stop_requested_at,retryable:state==='failed',
    content:p?.p_assistant_message ?? r.partial_content ?? null, modelUsed:p?.p_model_used ?? null,
    usage:p?.p_usage ?? null,search:publicSearchEvidence(p?.p_token_metadata?.search_evidence),
    billing:{state:state==='succeeded'?'settled':state==='failed'?'released':r.pre_deduct_id?'reserved':'unreserved',
      estimatedCredits:r.reservation ? Number(r.reservation.balance_before)-Number(r.reservation.balance_after) : 0,
      credits:state==='succeeded'?p?.p_total_credits:null,
      refunded:state==='failed'?b?.refund_amount:state==='succeeded'?b?.refunded_credits:null},
    userMessageId:b?.user_message_id??null,assistantMessageId:b?.assistant_message_id??null,
  };
}

export async function recoverChatResult(admin:any,r:ChatRequest) {
  if(r.state!=='responded') return r;
  const p=r.response_params;
  try {
    await ordinaryChatRequest(admin,r.user_id,r.request_id,r.writer_token).billing.finalizeAISuccess({
      conversationId:r.conversation_id,requestId:r.request_id,userMessage:r.input.message,
      assistantMessage:p.p_assistant_message,modelUsed:p.p_model_used,costUsd:Number(p.p_total_cost_usd),
      credits:p.p_total_credits,preDeductId:r.pre_deduct_id,usage:p.p_usage,
      tokenMetadata:p.p_token_metadata,usageMetadata:p.p_usage_metadata,inputLength:p.p_input_length,
      latencyMs:p.p_latency_ms,searchCount:p.p_search_count,ipAddress:p.p_ip_address,userAgent:p.p_user_agent,
    });
  } catch { /* Keep the saved result with pending settlement; never regenerate. */ }
  return await readChatRequest(admin,r.user_id,r.request_id) ?? r;
}

export async function isUnmeteredRateLimit(response:Response) {
  if(response.status!==429) return false;
  try {
    const text=await response.text(); if(text.length>16384)return false;
    const data=JSON.parse(text);
    return data && typeof data==='object' && !Array.isArray(data) &&
      !('choices' in data) && !('usage' in data) && !('data' in data) &&
      data.error && typeof data.error==='object' && !Array.isArray(data.error) &&
      (data.error.code===429 || data.error.code==='429' || data.error.code==='rate_limit_exceeded') &&
      typeof data.error.message==='string' &&
      !('choices' in data.error) && !('usage' in data.error);
  } catch {return false;}
}
