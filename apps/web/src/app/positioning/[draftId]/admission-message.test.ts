/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {admissionMessage} from './admission-message';
const message='本次操作所需模型尚未获准用于当前测试窗口，请联系管理员。';
it.each(['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE'].flatMap(code=>['opc.prepareStep','opc.mentorTurnStream'].map(path=>[code,path])))('presents a structured %s admission refusal from %s while retaining the same request',(code,path)=>{
 const result=admissionMessage(Object.assign(new Error(message),{data:{code,path}}));
 expect(result).toContain(message);expect(result).toContain('原请求与输入已保留');expect(result).toContain('同一请求');expect(result).not.toMatch(/版本已变化|结果未知|结果暂未确认/);
});
it.each([
 new Error(message),Object.assign(new Error(message),{data:{code:'INTERNAL_SERVER_ERROR',path:'opc.prepareStep'}}),
 Object.assign(new Error(message),{data:{code:'INTERNAL_SERVER_ERROR',path:'opc.mentorTurnStream'}}),
 Object.assign(new Error(message),{data:{code:'SERVICE_UNAVAILABLE',path:'runtime.execute'}}),
 Object.assign(new Error(message),{data:{code:'CONFLICT',path:'workbench.execute'}}),new Error('network timeout'),
])('does not reinterpret a missing response, execution or conflict as a known admission refusal %#',cause=>{
 expect(admissionMessage(cause)).toBeNull();
});

it('uses fixed expired-card wording without claiming the rejected envelope was retained',()=>{
 expect(admissionMessage(new Error('OPC_ANSWER_SOURCE_DENIED'))).toBe('这张卡已经过期，请看最新的回复。');
 expect(admissionMessage(new Error('OPC_ANSWER_SOURCE_DENIED: private details'))).toBeNull();
});

const gateNotices={
 minute:'操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。',
 day:'近24小时使用次数已达上限，请稍后再试。本次被拦截的调用不扣积分。',
 paused:'AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。',
 unavailable:'暂时无法确认使用额度，请稍后再试。本次被拦截的调用不扣积分。',
};
it.each(['opc.prepareStep','opc.mentorTurnStream','runtime.prepare'].flatMap(path=>[
 [path,'TOO_MANY_REQUESTS',gateNotices.minute,gateNotices.minute],
 [path,'TOO_MANY_REQUESTS','请求过于频繁，请在 30 秒后重试',gateNotices.minute],
 [path,'TOO_MANY_REQUESTS',gateNotices.day,gateNotices.day],
 [path,'SERVICE_UNAVAILABLE',gateNotices.paused,gateNotices.paused],
 [path,'SERVICE_UNAVAILABLE',gateNotices.unavailable,gateNotices.unavailable],
]))('shows only the fixed new-work gate notice for %s %s',(path,code,serverText,notice)=>{
 expect(admissionMessage(Object.assign(new Error(serverText),{data:{code,path,retryAfter:30}}))).toBe(notice);
});
it('keeps other 503 admission refusals on their existing wording and ignores 429 from other procedures',()=>{
 const other=Object.assign(new Error('工作空间服务暂不可用，请稍后重试。'),{data:{code:'SERVICE_UNAVAILABLE',path:'opc.prepareStep'}});
 expect(admissionMessage(other)).toBe('工作空间服务暂不可用，请稍后重试。 原请求与输入已保留；条件恢复后可继续核对同一请求。');
 expect(admissionMessage(Object.assign(new Error(gateNotices.minute),{data:{code:'TOO_MANY_REQUESTS',path:'runtime.execute'}}))).toBeNull();
});
