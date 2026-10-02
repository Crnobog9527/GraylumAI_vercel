/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isAnswerSourceDenied} from "./mentor-turn";
import {gateAdmissionNotice} from "@/lib/runtime-gate-notice";
const admissionPaths=['opc.prepareStep','opc.mentorTurnStream','runtime.prepare'];
/** Only an explicit admission response can replace the unknown-outcome notice.
 * This changes wording only: the original request and recovery identity stay. */
export function admissionMessage(cause:unknown):string|null {
 if(isAnswerSourceDenied(cause))return '这张卡已经过期，请看最新的回复。';
 const gate=gateAdmissionNotice(cause,admissionPaths);
 if(gate)return gate;
 if(!(cause instanceof Error)||!('data' in cause)||!cause.data||typeof cause.data!=='object')return null;
 const data=cause.data as {code?:unknown;path?:unknown};
 if(!admissionPaths.includes(String(data.path))||
  !['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE'].includes(String(data.code)))return null;
 return cause.message+' 原请求与输入已保留；条件恢复后可继续核对同一请求。';
}
