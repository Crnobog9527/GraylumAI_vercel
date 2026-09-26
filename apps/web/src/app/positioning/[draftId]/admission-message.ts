/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Only an explicit admission response can replace the unknown-outcome notice.
 * This changes wording only: the original request and recovery identity stay. */
export function admissionMessage(cause:unknown):string|null {
 if(!(cause instanceof Error)||!('data' in cause)||!cause.data||typeof cause.data!=='object')return null;
 const data=cause.data as {code?:unknown;path?:unknown};
 if(!['opc.prepareStep','runtime.prepare'].includes(String(data.path))||
  !['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE'].includes(String(data.code)))return null;
 return cause.message+' 原请求与输入已保留；条件恢复后可继续核对同一请求。';
}
