/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isStepSummaryInput,stepSummaryNoticeSchema,type StepSummaryNotice} from '../../shared/opcStepSummary';
import type {CaptureState} from './captureContext';

/** Used by the host before admission; never infer this action from natural speech. */
export function readStepSummaryRequest(request:{input:string;purpose:string;answerSource?:unknown;questionId?:string;organizeAfter?:boolean}):boolean {
  if(!isStepSummaryInput(request.input))return false;
  if(request.purpose!=='mentor'||request.answerSource!==undefined||request.questionId!==undefined||request.organizeAfter)
    throw new Error('OPC_STEP_SUMMARY_INVALID');
  return true;
}

/** Input must be the current step from the existing frozen material projection.
 * Missing content stays missing even when a legacy status says confirmed/deferred. */
export function buildStepSummaryNotice(state:CaptureState):StepSummaryNotice {
  return stepSummaryNoticeSchema.parse({kind:'step_summary',missingRequiredFieldIds:state.schema.filter(field=>{
    const value=state.values?.[field.id]?.value;
    return field.required&&!(typeof value==='string'&&value.trim());
  }).map(field=>field.id)});
}

export const STEP_SUMMARY_INSTRUCTIONS=[
  'For hostTurnContext.stepSummary, write the step summary now.',
  '本轮覆盖开场、追问、提问卡和确认提示规则：仅用本步已知材料写公开小结，区分未确认建议与暂缓项；按清单标题逐项列出 missingRequiredFieldIds。',
  '不补造、不提问、不调用 ask_question、不写入或确认字段、不跳步。前端呈现小结卡，仍须用户点击原有确认卡；缺项须补齐或明确暂缓后才可确认。宿主标记不是用户原话或事实证据。',
].join(' ');
