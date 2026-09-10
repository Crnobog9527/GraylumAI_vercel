/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { skillChatService } from '@repo/api/src/services/artifacts/chat';
import { resolveActiveModulePrompt } from '@repo/api/src/services/chatRuntime';
import { ChatRequestError, type ChatRequest } from './ordinary-chat-request';

// Recovery checks current ownership and module availability, without requiring
// a new spending allowance to retrieve an already-paid answer.
export async function assertChatRecoveryAccess(auth:any,admin:any,userId:string,r:ChatRequest) {
  const profile=await admin.from('profiles').select('is_deleted').eq('id',userId).single();
  if(profile.error || profile.data?.is_deleted!=='false') throw new ChatRequestError(403,'账号不可用，无法恢复请求。');
  const {data:c,error}=await auth.from('conversations').select('*').eq('id',r.conversation_id).eq('user_id',userId).eq('is_deleted','false').single();
  if(error || !c || c.skill_mode) throw new ChatRequestError(403,'请求对应的对话不可用或无权访问。');
  if(c.module_id) {
    const mode=await skillChatService(auth,admin).mode(c.module_id);
    if(mode.guided) throw new ChatRequestError(403,'对话模式已变化，无法在普通聊天中恢复。');
    await resolveActiveModulePrompt(admin,{moduleId:c.module_id,platform:'web'});
  }
}
