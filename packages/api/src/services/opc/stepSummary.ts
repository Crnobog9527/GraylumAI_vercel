/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {isStepSummaryInput,stepSummaryNoticeSchema,type StepSummaryNotice} from '../../shared/opcStepSummary';
import type {CaptureState} from './captureContext';

/** Used by the host before admission; never infer this action from natural speech. */
export function readStepSummaryRequest(request:{input:string;purpose:string;answerSource?:unknown;questionId?:string}):boolean {
  if(!isStepSummaryInput(request.input))return false;
  if(request.purpose!=='mentor'||request.answerSource!==undefined||request.questionId!==undefined)
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
  'The host explicitly requests a summary of the current step in hostTurnContext.stepSummary.',
  'For this turn this overrides opening, gap-finding and question-card rules: write the step summary now, even when required information is missing.',
  'Write public natural-language summary text; the frontend presents it as the step summary/confirmation card.',
  'Summarize only known material for the current step. Distinguish unconfirmed proposals and explicit deferrals from confirmed facts.',
  'List every missingRequiredFieldIds item by its current checklist title. Do not invent values or automatically defer missing information.',
  'Do not ask a follow-up question, call ask_question, advance steps, generate a final artifact, or change any field or confirmation state.',
  'The user must still click the existing whole-step confirmation card; this request and verbal assent are never confirmation.',
  'If required information is missing, say it must be supplied or explicitly deferred before that confirmation can succeed.',
  'The host marker is an action notice, not new user speech, an answer or evidence for extraction.',
].join(' ');
