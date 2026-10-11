/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isAnswerSourceDenied} from "./mentor-turn";
import {gateAdmissionNotice} from "@/lib/runtime-gate-notice";
import {isOrganizerPendingError,ORGANIZER_PENDING_NOTICE} from "@/lib/payg-wait";
const admissionPaths=['opc.prepareStep','opc.mentorTurnStream','runtime.prepare'];
const retained=' 原请求与输入已保留；条件恢复后可继续核对同一请求。';
/** Only an explicit admission response can replace the unknown-outcome notice.
 * This changes wording only: the original request and recovery identity stay.
 * Refusals keep their fixed server wording (PRECONDITION_FAILED/FORBIDDEN come
 * from the fixed staging table); any other 503 gets one fixed notice and never
 * its server text, nor a rate-limit notice it is not. */
export function admissionMessage(cause:unknown):string|null {
 if(isAnswerSourceDenied(cause))return '这张卡已经过期，请看最新的回复。';
 if(isOrganizerPendingError(cause))return ORGANIZER_PENDING_NOTICE;
 if(cause instanceof Error&&cause.message==='OPC_CAPTURE_INPUT_LIMIT')
  return '这一步要带给导师的内容超出了单次能处理的长度，这次没有发送，也没有扣费。可以直接在右侧清单核对后确认。';
 if(cause instanceof Error&&cause.message==='OPC_STEP_SUMMARY_INVALID')
  return '这次“这一步先到这里”没有被接受，没有扣费。可以继续和导师聊，或稍后再点一次。';
 const gate=gateAdmissionNotice(cause,admissionPaths);
 if(gate)return gate;
 if(!(cause instanceof Error)||!('data' in cause)||!cause.data||typeof cause.data!=='object')return null;
 const data=cause.data as {code?:unknown;path?:unknown};
 if(!admissionPaths.includes(String(data.path)))return null;
 if(data.code==='SERVICE_UNAVAILABLE')return '服务暂时不可用，请稍后再试。'+retained;
 if(!['PRECONDITION_FAILED','FORBIDDEN'].includes(String(data.code)))return null;
 return cause.message+retained;
}
