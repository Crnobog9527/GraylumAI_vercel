/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {admissionMessage} from './admission-message';
const message='本次操作所需模型尚未获准用于当前测试窗口，请联系管理员。';
it.each(['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE'])('presents a structured %s admission refusal while retaining the same request',code=>{
 const result=admissionMessage(Object.assign(new Error(message),{data:{code,path:'opc.prepareStep'}}));
 expect(result).toContain(message);expect(result).toContain('原请求与输入已保留');expect(result).toContain('同一请求');expect(result).not.toMatch(/版本已变化|结果未知|结果暂未确认/);
});
it.each([
 new Error(message),Object.assign(new Error(message),{data:{code:'INTERNAL_SERVER_ERROR',path:'opc.prepareStep'}}),
 Object.assign(new Error(message),{data:{code:'SERVICE_UNAVAILABLE',path:'runtime.execute'}}),
 Object.assign(new Error(message),{data:{code:'CONFLICT',path:'workbench.execute'}}),new Error('network timeout'),
])('does not reinterpret a missing response, execution or conflict as a known admission refusal %#',cause=>{
 expect(admissionMessage(cause)).toBeNull();
});
