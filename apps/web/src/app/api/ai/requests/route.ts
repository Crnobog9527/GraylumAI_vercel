/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isEmailVerified } from '@repo/api/src/lib/auth';
import { checkUserStatus } from '@repo/api/src/middleware/securityChecks';
import { ChatRequestError,ordinaryChatRequest,publicChatRequest,readChatRequest,recoverChatResult } from '@/lib/ordinary-chat-request';
import { assertChatRecoveryAccess } from '@/lib/ordinary-chat-access';

async function handle(request:NextRequest,stop=false) {
  try {
    const token=request.headers.get('authorization')?.replace('Bearer ','');
    if(!token) return Response.json({error:'请重新登录后恢复请求。'},{status:401});
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const auth=createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{global:{headers:{Authorization:`Bearer ${token}`}}});
    const {data:{user},error}=await auth.auth.getUser(token);
    if(error||!user)return Response.json({error:'请重新登录后恢复请求。'},{status:401});
    if(!isEmailVerified(user))return Response.json({error:'请先验证邮箱。'},{status:403});
    await checkUserStatus({supabase:auth,userId:user.id});
    const id=request.nextUrl.searchParams.get('requestId');
    if(!id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return Response.json({error:'请求标识无效。'},{status:400});
    const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!);
    let row=await readChatRequest(admin,user.id,id);
    if(!row)return Response.json({request:null},{status:404});
    await assertChatRecoveryAccess(auth,admin,user.id,row);
    if(stop)row=await ordinaryChatRequest(admin,user.id,id,row.writer_token).transition('stop');
    row=await recoverChatResult(admin,row!);
    return Response.json({request:publicChatRequest(row)},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    const status=error instanceof ChatRequestError?error.status:error instanceof TRPCError&&error.code==='FORBIDDEN'?403:503;
    return Response.json({error:error instanceof ChatRequestError?error.message:'身份、权限或请求状态暂时无法确认，请稍后恢复。'},{status,headers:{'Cache-Control':'no-store'}});
  }
}
export const GET=(request:NextRequest)=>handle(request);
export const POST=(request:NextRequest)=>handle(request,true);
